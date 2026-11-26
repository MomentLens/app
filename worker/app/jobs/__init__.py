"""The worker's jobs, by the name each message carries in its `job` field (arch §5).

thumbnail_dims is gone: face_process replaced it at S-21, so the two never run on the same upload
(D-72). A thumbnail_dims message left in the queue is archived as a job the worker does not have.
"""

from app.jobs import blur_region, face_process, media_delete, reference_process
from app.jobs.base import Job

REGISTRY: dict[str, Job] = {
    job.name: job
    for job in (face_process.JOB, blur_region.JOB, reference_process.JOB, media_delete.JOB)
}


def run_setup_hooks(registry: dict[str, Job] = REGISTRY) -> None:
    """Runs each job's startup hook once, before the loop reads anything."""
    for job in registry.values():
        if job.setup is not None:
            job.setup()
