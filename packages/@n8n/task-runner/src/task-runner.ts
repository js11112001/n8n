import { isSerializedBuffer, toBuffer } from 'n8n-core';
import { ApplicationError, ensureError, randomInt } from 'n8n-workflow';
import { nanoid } from 'nanoid';
import { EventEmitter } from 'node:events';
import { type MessageEvent, WebSocket } from 'ws';

import type { BaseRunnerConfig } from '@/config/base-runner-config';
import type { BrokerMessage, RunnerMessage } from '@/message-types';
import { TaskRunnerNodeTypes } from '@/node-types';
import type { TaskResultData } from '@/runner-types';

import { TaskCancelledError } from './js-task-runner/errors/task-cancelled-error';

export interface Task<T = unknown> {
	taskId: string;
	settings?: T;
	active: boolean;
	cancelled: boolean;
}

export interface TaskOffer {
	offerId: string;
	validUntil: bigint;
}

interface DataRequest {
	taskId: string;
	requestId: string;
	resolve: (data: unknown) => void;
	reject: (error: unknown) => void;
}

interface NodeTypesRequest {
	taskId: string;
	requestId: string;
	resolve: (data: unknown) => void;
	reject: (error: unknown) => void;
}

interface RPCCall {
	callId: string;
	resolve: (data: unknown) => void;
	reject: (error: unknown) => void;
}

const OFFER_VALID_TIME_MS = 5000;
const OFFER_VALID_EXTRA_MS = 100;

/** Converts milliseconds to nanoseconds */
const msToNs = (ms: number) => BigInt(ms * 1_000_000);

export interface TaskRunnerOpts extends BaseRunnerConfig {
	taskType: string;
	name?: string;
}

export abstract class TaskRunner extends EventEmitter {
	id: string = nanoid();

	ws: WebSocket;

	canSendOffers = false;

	runningTasks: Map<Task['taskId'], Task> = new Map();

	offerInterval: NodeJS.Timeout | undefined;

	openOffers: Map<TaskOffer['offerId'], TaskOffer> = new Map();

	dataRequests: Map<DataRequest['requestId'], DataRequest> = new Map();

	nodeTypesRequests: Map<NodeTypesRequest['requestId'], NodeTypesRequest> = new Map();

	rpcCalls: Map<RPCCall['callId'], RPCCall> = new Map();

	nodeTypes: TaskRunnerNodeTypes = new TaskRunnerNodeTypes([]);

	taskType: string;

	maxConcurrency: number;

	name: string;

	private idleTimer: NodeJS.Timeout | undefined;

	/** How long (in seconds) a task is allowed to take for completion, else the task will be aborted. */
	protected readonly taskTimeout: number;

	/** How long (in seconds) a runner may be idle for before exit. */
	private readonly idleTimeout: number;

	protected taskCancellations = new Map<Task['taskId'], AbortController>();

	constructor(opts: TaskRunnerOpts) {
		super();
		this.taskType = opts.taskType;
		this.name = opts.name ?? 'Node.js Task Runner SDK';
		this.maxConcurrency = opts.maxConcurrency;
		this.taskTimeout = opts.taskTimeout;
		this.idleTimeout = opts.idleTimeout;

		const { host: taskBrokerHost } = new URL(opts.taskBrokerUri);

		const wsUrl = `ws://${taskBrokerHost}/runners/_ws?id=${this.id}`;
		this.ws = new WebSocket(wsUrl, {
			headers: {
				authorization: `Bearer ${opts.grantToken}`,
			},
			maxPayload: opts.maxPayloadSize,
		});

		this.ws.addEventListener('error', (event) => {
			const error = ensureError(event.error);

			if (
				'code' in error &&
				typeof error.code === 'string' &&
				['ECONNREFUSED', 'ENOTFOUND'].some((code) => code === error.code)
			) {
				console.error(
					`Error: Failed to connect to n8n task broker. Please ensure n8n task broker is reachable at: ${taskBrokerHost}`,
				);
				process.exit(1);
			} else {
				console.error(`Error: Failed to connect to n8n task broker at ${taskBrokerHost}`);
				console.error('Details:', event.message || 'Unknown error');
			}
		});
		this.ws.addEventListener('message', this.receiveMessage);
		this.ws.addEventListener('close', this.stopTaskOffers);
		this.resetIdleTimer();
	}

	private resetIdleTimer() {
		if (this.idleTimeout === 0) return;

		this.clearIdleTimer();

		this.idleTimer = setTimeout(() => {
			if (this.runningTasks.size === 0) this.emit('runner:reached-idle-timeout');
		}, this.idleTimeout * 1000);
	}

	private receiveMessage = (message: MessageEvent) => {
		// eslint-disable-next-line n8n-local-rules/no-uncaught-json-parse
		const data = JSON.parse(message.data as string) as BrokerMessage.ToRunner.All;
		void this.onMessage(data);
	};

	private stopTaskOffers = () => {
		this.canSendOffers = false;
		if (this.offerInterval) {
			clearInterval(this.offerInterval);
			this.offerInterval = undefined;
		}
	};

	private startTaskOffers() {
		this.canSendOffers = true;
		if (this.offerInterval) {
			clearInterval(this.offerInterval);
		}
		this.offerInterval = setInterval(() => this.sendOffers(), 250);
	}

	deleteStaleOffers() {
		this.openOffers.forEach((offer, key) => {
			if (offer.validUntil < process.hrtime.bigint()) {
				this.openOffers.delete(key);
			}
		});
	}

	sendOffers() {
		this.deleteStaleOffers();

		if (!this.canSendOffers) {
			return;
		}

		const offersToSend = this.maxConcurrency - (this.openOffers.size + this.runningTasks.size);

		for (let i = 0; i < offersToSend; i++) {
			// Add a bit of randomness so that not all offers expire at the same time
			const validForInMs = OFFER_VALID_TIME_MS + randomInt(500);
			// Add a little extra time to account for latency
			const validUntil = process.hrtime.bigint() + msToNs(validForInMs + OFFER_VALID_EXTRA_MS);
			const offer: TaskOffer = {
				offerId: nanoid(),
				validUntil,
			};
			this.openOffers.set(offer.offerId, offer);
			this.send({
				type: 'runner:taskoffer',
				taskType: this.taskType,
				offerId: offer.offerId,
				validFor: validForInMs,
			});
		}
	}

	send(message: RunnerMessage.ToBroker.All) {
		this.ws.send(JSON.stringify(message));
	}

	onMessage(message: BrokerMessage.ToRunner.All) {
		switch (message.type) {
			case 'broker:inforequest':
				this.send({
					type: 'runner:info',
					name: this.name,
					types: [this.taskType],
				});
				break;
			case 'broker:runnerregistered':
				this.startTaskOffers();
				break;
			case 'broker:taskofferaccept':
				this.offerAccepted(message.offerId, message.taskId);
				break;
			case 'broker:taskcancel':
				this.taskCancelled(message.taskId, message.reason);
				break;
			case 'broker:tasksettings':
				void this.receivedSettings(message.taskId, message.settings);
				break;
			case 'broker:taskdataresponse':
				this.processDataResponse(message.requestId, message.data);
				break;
			case 'broker:rpcresponse':
				this.handleRpcResponse(message.callId, message.status, message.data);
				break;
			case 'broker:nodetypes':
				this.processNodeTypesResponse(message.requestId, message.nodeTypes);
				break;
		}
	}

	processDataResponse(requestId: string, data: unknown) {
		const request = this.dataRequests.get(requestId);
		if (!request) {
			return;
		}
		// Deleting of the request is handled in `requestData`, using a
		// `finally` wrapped around the return
		request.resolve(data);
	}

	processNodeTypesResponse(requestId: string, nodeTypes: unknown) {
		const request = this.nodeTypesRequests.get(requestId);

		if (!request) return;

		// Deleting of the request is handled in `requestNodeTypes`, using a
		// `finally` wrapped around the return
		request.resolve(nodeTypes);
	}

	hasOpenTasks() {
		return this.runningTasks.size < this.maxConcurrency;
	}

	offerAccepted(offerId: string, taskId: string) {
		if (!this.hasOpenTasks()) {
			this.openOffers.delete(offerId);
			this.send({
				type: 'runner:taskrejected',
				taskId,
				reason: 'No open task slots',
			});
			return;
		}

		const offer = this.openOffers.get(offerId);
		if (!offer) {
			this.send({
				type: 'runner:taskrejected',
				taskId,
				reason: 'Offer expired and no open task slots',
			});
			return;
		} else {
			this.openOffers.delete(offerId);
		}

		this.resetIdleTimer();
		this.runningTasks.set(taskId, {
			taskId,
			active: false,
			cancelled: false,
		});

		this.send({
			type: 'runner:taskaccepted',
			taskId,
		});
	}

	taskCancelled(taskId: string, reason: string) {
		const task = this.runningTasks.get(taskId);
		if (!task) {
			return;
		}
		task.cancelled = true;

		for (const [requestId, request] of this.dataRequests.entries()) {
			if (request.taskId === taskId) {
				request.reject(new TaskCancelledError(reason));
				this.dataRequests.delete(requestId);
			}
		}

		for (const [requestId, request] of this.nodeTypesRequests.entries()) {
			if (request.taskId === taskId) {
				request.reject(new TaskCancelledError(reason));
				this.nodeTypesRequests.delete(requestId);
			}
		}

		const controller = this.taskCancellations.get(taskId);
		if (controller) {
			controller.abort();
			this.taskCancellations.delete(taskId);
		}

		if (!task.active) this.runningTasks.delete(taskId);

		this.sendOffers();
	}

	taskErrored(taskId: string, error: unknown) {
		this.send({
			type: 'runner:taskerror',
			taskId,
			error,
		});
		this.runningTasks.delete(taskId);
		this.sendOffers();
	}

	taskDone(taskId: string, data: RunnerMessage.ToBroker.TaskDone['data']) {
		this.send({
			type: 'runner:taskdone',
			taskId,
			data,
		});
		this.runningTasks.delete(taskId);
		this.sendOffers();
	}

	async receivedSettings(taskId: string, settings: unknown) {
		const task = this.runningTasks.get(taskId);
		if (!task) {
			return;
		}
		if (task.cancelled) {
			this.runningTasks.delete(taskId);
			return;
		}

		const controller = new AbortController();
		this.taskCancellations.set(taskId, controller);

		const taskTimeout = setTimeout(() => {
			if (!task.cancelled) {
				controller.abort();
				this.taskCancellations.delete(taskId);
			}
		}, this.taskTimeout * 1_000);

		task.settings = settings;
		task.active = true;
		try {
			const data = await this.executeTask(task, controller.signal);
			this.taskDone(taskId, data);
		} catch (error) {
			if (!task.cancelled) this.taskErrored(taskId, error);
		} finally {
			clearTimeout(taskTimeout);
			this.taskCancellations.delete(taskId);
			this.resetIdleTimer();
		}
	}

	// eslint-disable-next-line @typescript-eslint/naming-convention
	async executeTask(_task: Task, _signal: AbortSignal): Promise<TaskResultData> {
		throw new ApplicationError('Unimplemented');
	}

	async requestNodeTypes<T = unknown>(
		taskId: Task['taskId'],
		requestParams: RunnerMessage.ToBroker.NodeTypesRequest['requestParams'],
	) {
		const requestId = nanoid();

		const nodeTypesPromise = new Promise<T>((resolve, reject) => {
			this.nodeTypesRequests.set(requestId, {
				requestId,
				taskId,
				resolve: resolve as (data: unknown) => void,
				reject,
			});
		});

		this.send({
			type: 'runner:nodetypesrequest',
			taskId,
			requestId,
			requestParams,
		});

		try {
			return await nodeTypesPromise;
		} finally {
			this.nodeTypesRequests.delete(requestId);
		}
	}

	async requestData<T = unknown>(
		taskId: Task['taskId'],
		requestParams: RunnerMessage.ToBroker.TaskDataRequest['requestParams'],
	): Promise<T> {
		const requestId = nanoid();

		const p = new Promise<T>((resolve, reject) => {
			this.dataRequests.set(requestId, {
				requestId,
				taskId,
				resolve: resolve as (data: unknown) => void,
				reject,
			});
		});

		this.send({
			type: 'runner:taskdatarequest',
			taskId,
			requestId,
			requestParams,
		});

		try {
			return await p;
		} finally {
			this.dataRequests.delete(requestId);
		}
	}

	async makeRpcCall(taskId: string, name: RunnerMessage.ToBroker.RPC['name'], params: unknown[]) {
		const callId = nanoid();

		const dataPromise = new Promise((resolve, reject) => {
			this.rpcCalls.set(callId, {
				callId,
				resolve,
				reject,
			});
		});

		try {
			this.send({
				type: 'runner:rpc',
				callId,
				taskId,
				name,
				params,
			});

			const returnValue = await dataPromise;

			return isSerializedBuffer(returnValue) ? toBuffer(returnValue) : returnValue;
		} finally {
			this.rpcCalls.delete(callId);
		}
	}

	handleRpcResponse(
		callId: string,
		status: BrokerMessage.ToRunner.RPCResponse['status'],
		data: unknown,
	) {
		const call = this.rpcCalls.get(callId);
		if (!call) {
			return;
		}
		if (status === 'success') {
			call.resolve(data);
		} else {
			call.reject(typeof data === 'string' ? new Error(data) : data);
		}
	}

	/** Close the connection gracefully and wait until has been closed */
	async stop() {
		this.clearIdleTimer();

		this.stopTaskOffers();

		await this.waitUntilAllTasksAreDone();

		await this.closeConnection();
	}

	clearIdleTimer() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private async closeConnection() {
		// 1000 is the standard close code
		// https://www.rfc-editor.org/rfc/rfc6455.html#section-7.1.5
		this.ws.close(1000, 'Shutting down');

		await new Promise((resolve) => {
			this.ws.once('close', resolve);
		});
	}

	private async waitUntilAllTasksAreDone(maxWaitTimeInMs = 30_000) {
		// TODO: Make maxWaitTimeInMs configurable
		const start = Date.now();

		while (this.runningTasks.size > 0) {
			if (Date.now() - start > maxWaitTimeInMs) {
				throw new ApplicationError('Timeout while waiting for tasks to finish');
			}

			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}
