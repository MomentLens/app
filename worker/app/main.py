"""MomentLens AI worker.

A pgmq consumer, not a web server (Handbook §6). The only HTTP surface is
/health, so a human on the box can tell whether the process is alive.

The queue loop, the job handlers and the resident InsightFace model land in
later slices. This is the trivial process P0-2 needs, so that
momentlens-worker.service has something to start, restart and log.
"""

import logging

import uvicorn
from fastapi import FastAPI

# nginx proxies the API and nothing else, so the worker stays on loopback.
HOST = "127.0.0.1"
PORT = 8000

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("momentlens.worker")

app = FastAPI(title="MomentLens worker")


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness only. The process is up; it says nothing about the queue."""
    return {"status": "ok"}


def main() -> None:
    """Entry point for `python -m app.main`, which is what systemd runs."""
    logger.info("worker starting on http://%s:%s, no jobs are consumed yet", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
