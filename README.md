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

This project is designed around submitting "research jobs" about birds, and using workers to process the research and make that research available again to the client. To acheive this I have taken an approach with 5 main components that denote the various separate concerns of the project, and all configuration information (like constants) are defined in [config](src/lib/config.ts)

These components are:

- DB
- Queue
- API
- Workers
- Observer

## [DB](src/lib/db.ts)

This is a super lightweight singleton wrapper over the LMDB root database object. On initialization if there is not already an instance it connects to the root database using the LMDB `open` function and returns the object (and tracks it as an instance). If there is already an instance it simply returns that object.

## [Queue](src/lib/queue.ts)

The Queue is the shared interface used by both the API (for submitJob) and workers (for claimJob/job updates). It acts as a clean interface with the underlying databases for handling all of the job related behaviors including setting a job for retry or marking it as failed. When a job is submitted it goes into the queue and is marked for being available for processing immediately. When a job encounters an error and has to be retried, it goes back into the queue (so that we don't hold up a worker with waiting) but is marked with a future data for being available for processing.

The DB uses two named LMDB databases within the same environment:

- **jobs**: keyed by job ID -> ResearchJob (the main data store)
- **queue-index**: keyed by composite `${zeroPaddedTimestamp}-${jobId}` -> job ID (a secondary index that keeps eligible jobs sorted by availableForProcessingAt, enabling O(1) job claiming)

## [API](src/index.ts)

The API is a simple express server with three endpoints: `GET /bird?name=...`, `POST /bird`, and `GET /metrics?window`.

## [Workers](src/worker/worker.ts)

Each worker is assigned a unique workerId on startup (e.g. a short random ID like "w-a3f1"). Each worker then runs a polling loop of claim job, process job. Claiming a job requires calling the claimJob function on the Queue, if it is given a job, then process it where processing it is just fetching from Wikipedia using the URL format of "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles={job.name}&format=json&formatversion=2". Each worker doesn't actually handle retries or backoff directly on their own, instead they just update the job in the Queue by moving the status back to "queued", updating the availableForProcessingAt timestamp to be (2^(job.retryCount + 1)) \* BASE_DELAY (plus some jitter), and incrementing the retryCount. There is also a MAX_RETRIES value and if job.retryCount == MAX_RETRIES and the current attempt to process the job fails, the status on the job is set to "failed". The workers are launched with a specific level of concurrency using an environment vairable. Each worker operates on a polling interval of 250ms.

## [Observer](src/observer/observer.ts)

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

# What I'd Do Next

## Return job status on GET regardless of completion

The current `GET /bird` returns 404 if the job isn't completed. In practice, clients need to see the current status of their request (queued, processing, failed) rather than getting an ambiguous 404.

## Replace the hand-written queue with Redis + BullMQ

The LMDB-backed queue works well for a single-machine setup, but scaling requires separating the API, queue, and workers onto different servers. Redis + BullMQ is the standard Node.js solution for this. BullMQ provides job submission, atomic claiming, retries with exponential backoff, etc out of the box. The API servers, workers, and Redis instance become independently deployable and horizontally scalable.

## Replace the hand-written observer with OpenTelemetry

The observer recomputes metrics from raw log data on every read, which won't scale — every `/metrics` call and every `checkFailureRate` invocation walks all entries in the time window. OpenTelemetry replaces this with proper instrumentation: distributed traces that follow a job across process boundaries automatically, pre-aggregated counters and histograms for metrics, and structured logs correlated by trace ID. The data exports to a managed backend (Datadog, Grafana Cloud, etc.) where alerting can be configured.

## Separate ephemeral queue state from durable research results

Both job lifecycle data and completed research results currently live in the same LMDB database. These have different lifetimes: queue entries (status, retryCount, timestamps) are ephemeral workflow state that should expire via TTL, while completed research results are business data that should be kept indefinitely. The fix is to persist completed results to a proper data store (Postgres, etc.) on job completion and let the queue entries expire. The GET endpoint reads from the durable store, not the queue. You can then add a cache in front of the proper data store for frequently requested birds.

## Graceful worker shutdown

Workers currently poll in an infinite loop with no shutdown handling. If the process is killed, any in-flight job is abandoned mid-processing. Adding a SIGTERM handler that stops the polling loop and waits for in-flight work to complete would be ideal.

## Fetch timeout on Wikipedia requests

The `processJob` function has no timeout on the Wikipedia API call. If the upstream hangs, the worker blocks indefinitely on a single job. Adding `AbortSignal.timeout()` to the fetch call would let the worker fail fast and retry rather than stalling.
