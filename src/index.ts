import express, { type Express } from "express";
import { Queue } from "./lib/queue.js";
import { Observer } from "./observer/observer.js";
import { ActionType, toJobId } from "./lib/types.js";
import { CONFIG } from "./lib/config.js";

export function createApp(queue: Queue, observer: Observer): Express {
  const app = express();

  app.use(express.json());

  app.use((req, _res, next) => {
    observer.log(ActionType.API_REQUEST, "log", {
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body as Record<string, unknown>,
    });
    next();
  });

  app.post("/bird", (req, res) => {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "Missing required field: name" });
      return;
    }

    const { job, isDuplicate } = queue.submitJob({ name });

    if (isDuplicate) {
      observer.log(ActionType.JOB_DUPLICATE, "log", {
        jobId: job.id,
        name: job.name,
        currentStatus: job.status,
      });
      res.status(200).json({
        id: job.id,
        name: job.name,
        status: job.status,
        createdAt: job.createdAt,
      });
    } else {
      observer.log(ActionType.JOB_SUBMITTED, "log", {
        jobId: job.id,
        name: job.name,
      });
      res.status(201).json({
        id: job.id,
        name: job.name,
        status: job.status,
        createdAt: job.createdAt,
      });
    }
  });

  app.get("/bird", (req, res) => {
    const name = req.query.name as string | undefined;
    if (!name) {
      res.status(400).json({ error: "Missing required query parameter: name" });
      return;
    }

    const jobId = toJobId(name);
    const job = queue.getJob(jobId);

    if (!job || job.status !== "completed") {
      res.status(404).json({ error: "Not found or not completed" });
      return;
    }

    res.json({
      id: job.id,
      name: job.name,
      status: job.status,
      createdAt: job.createdAt,
      body: job.body,
    });
  });

  app.get("/metrics", (req, res) => {
    const windowParam = req.query.window as string | undefined;
    const windowMs = windowParam ? parseInt(windowParam, 10) : undefined;
    const metrics = observer.getMetrics(windowMs);
    res.json(metrics);
  });

  return app;
}

const queue = new Queue(CONFIG.QUEUE_DB_PATH);
const observer = new Observer(CONFIG.OBSERVER_DB_PATH);
const app = createApp(queue, observer);

app.listen(CONFIG.PORT, () => {
  console.log(`Server running at http://localhost:${CONFIG.PORT}`);
});
