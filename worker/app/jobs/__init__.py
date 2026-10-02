"""The worker's jobs, by the name each message carries in its `job` field (arch §5).

S-21 removes thumbnail_dims from this registry when face_process replaces it, so the two never
run on the same upload (D-72).
"""

from app.jobs import thumbnail_dims
from app.jobs.base import Job

REGISTRY: dict[str, Job] = {job.name: job for job in (thumbnail_dims.JOB,)}


def run_setup_hooks(registry: dict[str, Job] = REGISTRY) -> None:
    """Runs each job's startup hook once, before the loop reads anything."""
    for job in registry.values():
        if job.setup is not None:
            job.setup()
