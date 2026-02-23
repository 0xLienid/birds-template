# Getting Started

## Install Dependencies

`npm install`

## Run Tests

`npm run tests`

## Run System

First start the workers with the following

```bash
WORKER_CONCURRENCY={your worker concurrency} npm run worker
```

Then in a new terminal instance in your working directory start the API with

```bash
npm run dev
```

# Overview

This project is designed around submitting "research jobs" about birds, and using workers to process the research and make that research available again to the client. To acheive this I have taken an approach with 5 main components that denote the various separate concerns of the project.

These components are:

- DB
- Queue
- API
- Workers
- Observer

## DB

This is a super lightweight singleton wrapper over the lmdb object. On initialization if there is not already an instance it connects to the root database using the lmdb `open` function and returns the object (and tracks it as an instance). If there is already an instance it simply returns that object.

## Queue

The Queue is the shared interface used by both the API (for submitJob) and workers (for claimJob/job updates). It acts as a clean interface with the underlying databases for handling all of the job related behaviors including setting a job for retry or marking it as failed. When a job is submitted it goes into the queue and is marked for being available for processing immediately. When a job encounters an error and has to be retried, it goes back into the queue (so that we don't hold up a worker with waiting) but is marked with a future data for being available for processing.

The DB uses two named LMDB databases within the same environment:

- **jobs**: keyed by job ID -> ResearchJob (the main data store)
- **queue-index**: keyed by composite `${zeroPaddedTimestamp}-${jobId}` -> job ID (a secondary index that keeps eligible jobs sorted by availableForProcessingAt, enabling O(1) job claiming)

## API

The API is a simple express server with three endpoints: `GET /bird?name=...`, `POST /bird`, and `GET /metrics?window`.

## Workers

Each worker is assigned a unique workerId on startup (e.g. a short random ID like "w-a3f1"). Each worker then runs a polling loop of claim job, process job. Claiming a job requires calling the claimJob function on the Queue, if it is given a job, then process it where processing it is just fetching from Wikipedia using the URL format of "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles={job.name}&format=json&formatversion=2". Each worker doesn't actually handle retries or backoff directly on their own, instead they just update the job in the Queue by moving the status back to "queued", updating the availableForProcessingAt timestamp to be (2^(job.retryCount + 1)) \* BASE_DELAY (plus some jitter), and incrementing the retryCount. There is also a MAX_RETRIES value and if job.retryCount == MAX_RETRIES and the current attempt to process the job fails, the status on the job is set to "failed". The workers are launched with a specific level of concurrency using an environment vairable. Each worker operates on a polling interval of 250ms.

## Observer

The Observer manages all logging, metrics, and observability. This uses another named LMDB database under the root DB. The Observer stores every log submitted to it which enables the tracing of specific jobs as they flow through the system (i.e. able to answer the question "Show me the full trace of the 'Brown pelican' job") as well as enables the computation of system level metrics and enables smooth triggering of alerts.

Metrics are computed on-read from the stored log data rather than pre-aggregated. This keeps the write path simple and avoids maintaining rolling counters or time-bucketed aggregates.

Alerting is passive: on each `log()` call, if the action is a failure event (e.g. "job-failed"), the failure rate is checked over a configurable window (default 3 hours). If it exceeds a threshold, call an `alert()` function (which for now just prints "ALERT: {message}" to stdout).

| Action        | Emitted by                                     | Type    | Body                                                          |
| ------------- | ---------------------------------------------- | ------- | ------------------------------------------------------------- |
| job-submitted | Queue.submitJob (new job)                      | log     | { jobId, name }                                               |
| job-duplicate | Queue.submitJob (existing, not failed)         | log     | { jobId, name, currentStatus }                                |
| job-claimed   | Worker, after claimJob returns a job           | log     | { jobId, name, workerId }                                     |
| job-completed | Worker, after successful fetch + DB write      | log     | { jobId, name, workerId }                                     |
| job-retry     | Worker, on failed fetch with retries remaining | warning | { jobId, name, workerId, retryCount, nextAvailableAt, error } |
| job-failed    | Worker, on failed fetch at MAX_RETRIES         | error   | { jobId, name, workerId, retryCount, error }                  |
| api-request   | API, on each incoming HTTP request             | log     | { method, path, query, body }                                 |
| worker-start  | Worker, when a worker process starts           | log     | { workerId }                                                  |
