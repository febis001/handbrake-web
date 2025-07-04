import hash from 'object-hash';
import { JobType, QueueRequestType, QueueStatus } from 'types/queue';
import { Socket as Worker } from 'socket.io';
import { TranscodeStage } from 'types/transcode';
import logger, { RemoveJobLogByID } from 'logging';
import {
	EmitToAllClients,
	EmitToWorkerWithID,
	GetWorkerID,
	GetWorkerWithID,
	GetWorkers,
} from './connections';
import {
	GetJobFromDatabase,
	GetQueueFromDatabase,
	InsertJobToDatabase,
	InsertJobToJobsOrderTable,
	RemoveJobFromDatabase,
	UpdateJobOrderIndexInDatabase,
	UpdateJobStatusInDatabase,
} from './database/database-queue';
import { GetStatusFromDatabase, UpdateStatusInDatabase } from './database/database-status';

// Init --------------------------------------------------------------------------------------------
export function InitializeQueue() {
	// Queue Status
	const status = GetQueueStatus();
	if (status != null || status != undefined) {
		logger.info(
			`[server] [queue] Existing queue status '${QueueStatus[status]}' retreived from the database.`
		);
		EmitToAllClients('queue-status-update', status);
	} else {
		SetQueueStatus(QueueStatus.Stopped);
		logger.error(
			`[server] [queue] The queue status does not exist in the database, initializing to the state 'stopped'.`
		);
	}

	// Queue Data
	const queue = GetQueueFromDatabase();
	if (queue) {
		Object.keys(queue)
			.map((key) => parseInt(key))
			.forEach((jobID) => {
				const job = queue[jobID];
				if (
					job.status.worker_id != null ||
					job.status.transcode_stage == TranscodeStage.Scanning ||
					job.status.transcode_stage == TranscodeStage.Transcoding
				) {
					StopJob(jobID);

					logger.info(
						`[server] [queue] Job '${jobID}' was loaded from the database in an unfinished state. The job will be updated to 'Stopped'.`
					);
				}
			});
		EmitToAllClients('queue-update', queue);
	}
}

export function GetBusyWorkers() {
	const busyWorkers = GetWorkers().filter((worker) => {
		return Object.values(GetQueue())
			.filter((job) => job.status.worker_id != null)
			.map((job) => job.status.worker_id)
			.includes(GetWorkerID(worker));
	});
	return busyWorkers;
}

export function GetAvailableWorkers() {
	const availableWorkers = GetWorkers().filter((worker) => {
		return !Object.values(GetQueue())
			.filter((job) => job.status.worker_id != null)
			.map((job) => job.status.worker_id)
			.includes(GetWorkerID(worker));
	});
	return availableWorkers;
}

export function GetAvailableJobs() {
	const queue = GetQueue();
	const availableJobs = Object.keys(queue)
		.map((key) => parseInt(key))
		.filter((key) => queue[key].status.transcode_stage == TranscodeStage.Waiting)
		.sort((keyA, keyB) => queue[keyA].order_index - queue[keyB].order_index);
	return availableJobs;
}

export function JobForAvailableWorkers(jobID: number) {
	if (GetQueueStatus() != QueueStatus.Stopped) {
		logger.info(
			`[server] [queue] Job with ID '${jobID}' is available, checking for available workers...`
		);
		const availableWorkers = GetAvailableWorkers();
		if (availableWorkers.length > 0) {
			const selectedWorker = availableWorkers[0];
			const job = GetJobFromDatabase(jobID);
			if (job) {
				StartJob(jobID, job, selectedWorker);
				if (GetQueueStatus() != QueueStatus.Active) {
					SetQueueStatus(QueueStatus.Active);
				}
				logger.info(
					`[server] [queue] Found worker with ID '${GetWorkerID(
						selectedWorker
					)}' for job with ID '${jobID}'.`
				);
			}
		} else {
			logger.info(
				`[server] [queue] There are no workers available for job with ID '${jobID}'.`
			);
		}
	}
}

export function WorkerForAvailableJobs(workerID: string) {
	if (GetQueueStatus() != QueueStatus.Stopped) {
		logger.info(
			`[server] [queue] Worker with ID '${workerID}' is available, checking for available jobs...`
		);
		const availableJobs = GetAvailableJobs();
		if (availableJobs.length > 0) {
			const worker = GetWorkerWithID(workerID);
			const selectedJobID = availableJobs[0];
			const selectedJob = GetJobFromDatabase(selectedJobID);
			if (selectedJob && worker) {
				StartJob(selectedJobID, selectedJob, worker);
				if (GetQueueStatus() != QueueStatus.Active) {
					SetQueueStatus(QueueStatus.Active);
				}
				logger.info(
					`[server] [queue] Found job with ID '${selectedJobID}' for worker with ID '${workerID}'.`
				);
			}
		} else {
			logger.info(
				`[server] [queue] There are no jobs available for worker with ID '${workerID}'.`
			);
			// Set queue to idle if there are no other busy workers
			if (GetBusyWorkers().length == 0) {
				SetQueueStatus(QueueStatus.Idle);
				logger.info("[queue] There are no active workers, setting queue to 'Idle'.");
			}
		}
	}
}

// Status ------------------------------------------------------------------------------------------
export function GetQueueStatus() {
	const status = GetStatusFromDatabase('queue')?.state as QueueStatus;
	return status;
}

export function SetQueueStatus(newState: QueueStatus) {
	UpdateStatusInDatabase('queue', newState);
	EmitToAllClients('queue-status-update', newState);
}

export function StartQueue(clientID: string) {
	if (GetQueueStatus() == QueueStatus.Stopped) {
		try {
			const availableWorkers = GetAvailableWorkers();
			const availableJobs = GetAvailableJobs();
			const moreJobs = availableWorkers.length < availableJobs.length;
			const maxConcurrent = moreJobs ? availableWorkers.length : availableJobs.length;
			logger.info(
				`[server] [queue] There are more ${moreJobs ? 'jobs' : 'workers'} than ${
					moreJobs ? 'workers' : 'jobs'
				}, the max amount of concurrent jobs is ${maxConcurrent} job(s).`
			);

			if (maxConcurrent > 0) {
				for (let i = 0; i < maxConcurrent; i++) {
					const selectedJobID = availableJobs[i];
					const selectedJob = GetJobFromDatabase(selectedJobID);
					const selectedWorker = availableWorkers[i];
					const selectedWorkerID = GetWorkerID(selectedWorker);

					if (selectedJob) {
						StartJob(selectedJobID, selectedJob, selectedWorker);

						logger.info(
							`[server] [queue] Assigning worker '${selectedWorkerID}' to job '${selectedJobID}'.`
						);
					} else {
						throw new Error(
							`[server] [queue] Cannot find job with ID '${selectedJobID}' in the database.`
						);
					}
				}
				SetQueueStatus(QueueStatus.Active);
			} else {
				logger.info(
					`[server] [queue] Setting the queue to idle because there are no ${
						moreJobs ? 'workers' : 'jobs'
					} available for ${moreJobs ? 'jobs' : 'workers'}.`
				);
				SetQueueStatus(QueueStatus.Idle);
			}
		} catch (err) {
			logger.error(err);
		}
	}
}

export function StopQueue(clientID?: string) {
	if (GetQueueStatus() != QueueStatus.Stopped) {
		const newStatus = QueueStatus.Stopped;
		SetQueueStatus(newStatus);

		const stoppedBy = clientID ? `client '${clientID}'` : 'the server.';

		logger.info(`[server] The queue has been stopped by ${stoppedBy}.`);
	}
}

// Queue -------------------------------------------------------------------------------------------
export function GetQueue() {
	const queue = GetQueueFromDatabase();
	if (queue) {
		return queue;
	} else {
		throw new Error('Could not get the queue from the database.');
	}
}

export function UpdateQueue() {
	const updatedQueue = GetQueueFromDatabase();
	if (updatedQueue) {
		EmitToAllClients('queue-update', updatedQueue);
	}
}

// Job Actions -------------------------------------------------------------------------------------
export function AddJob(data: QueueRequestType) {
	const job = InsertJobToDatabase(data);
	if (job) {
		UpdateQueue();
		JobForAvailableWorkers(job);
	}
}

export function StartJob(jobID: number, job: JobType, worker: Worker) {
	const workerID = GetWorkerID(worker);
	job.status.worker_id = workerID;
	job.status.time_started = new Date().getTime();
	UpdateJobStatusInDatabase(jobID, {
		worker_id: workerID,
		time_started: new Date().getTime(),
	});
	worker.emit('start-transcode', jobID);
}

export function StopJob(job_id: number, isError: boolean = false) {
	const job = GetJobFromDatabase(job_id);
	if (job) {
		// Tell the worker to stop transcoding
		const worker = job.status.worker_id;
		if (worker) {
			if (GetWorkerWithID(worker)) {
				EmitToWorkerWithID(worker, 'stop-transcode', job_id);
			}
		}

		const newStage = isError ? TranscodeStage.Error : TranscodeStage.Stopped;

		// Update Job in database
		UpdateJobOrderIndexInDatabase(job_id, 0);
		UpdateJobStatusInDatabase(job_id, {
			worker_id: null,
			transcode_stage: newStage,
			transcode_percentage: 0,
			transcode_eta: 0,
			transcode_fps_current: 0,
			transcode_fps_average: 0,
			time_started: 0,
			time_finished: Date.now(),
		});
		UpdateQueue();
		if (worker) {
			WorkerForAvailableJobs(worker);
		}
	} else {
		logger.error(
			`[server] Job with id '${job_id}' does not exist, unable to stop the requested job.`
		);
	}
}

export function ResetJob(job_id: number) {
	const job = GetJobFromDatabase(job_id);
	if (job) {
		if (
			job.status.transcode_stage == TranscodeStage.Stopped ||
			job.status.transcode_stage == TranscodeStage.Finished ||
			job.status.transcode_stage == TranscodeStage.Error
		) {
			// Update Job in database
			InsertJobToJobsOrderTable(job_id);
			UpdateJobStatusInDatabase(job_id, {
				worker_id: null,
				transcode_stage: TranscodeStage.Waiting,
				transcode_percentage: 0,
				transcode_eta: 0,
				transcode_fps_current: 0,
				transcode_fps_average: 0,
				time_started: 0,
				time_finished: 0,
			});

			UpdateQueue();
			JobForAvailableWorkers(job_id);
		} else {
			logger.error(
				`[server] [error] Job with id '${job_id}' cannot be reset because it is not in a stopped/finished/error state.`
			);
		}
	} else {
		logger.error(
			`[server] Job with id '${job_id}' does not exist, unable to reset the requested job.`
		);
	}
}

export function RemoveJob(job_id: number) {
	const job = GetJobFromDatabase(job_id);
	if (job) {
		RemoveJobFromDatabase(job_id);
		RemoveJobLogByID(job_id);
		UpdateQueue();
	} else {
		logger.error(
			`[server] Job with id '${job_id}' does not exist, unable to remove the requested job.`
		);
	}
}

export function ClearQueue(clientID: string, finishedOnly: boolean = false) {
	logger.info(
		`[server] [queue] Client '${clientID}' has requested to clear ${
			finishedOnly ? 'finished' : 'all'
		} jobs from the queue.`
	);
	const queue = GetQueueFromDatabase();
	if (queue) {
		for (const key of Object.keys(queue).map((key) => parseInt(key))) {
			const job: JobType = queue[key];

			switch (job.status.transcode_stage) {
				case TranscodeStage.Waiting:
					if (!finishedOnly) {
						RemoveJobFromDatabase(key);
						logger.info(
							`[server] Removing job '${key}' from the queue due to being 'Waiting'.`
						);
					}
					break;
				case TranscodeStage.Finished:
					RemoveJobFromDatabase(key);
					logger.info(
						`[server] Removing job '${key}' from the queue due to being 'Finished'.`
					);
					break;
				case TranscodeStage.Stopped:
					if (!finishedOnly) {
						RemoveJobFromDatabase(key);
						logger.info(
							`[server] Removing job '${key}' from the queue due to being 'Stopped'.`
						);
					}
			}
		}

		UpdateQueue();
	}
}
