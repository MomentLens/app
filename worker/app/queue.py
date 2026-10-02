"""pgmq calls on the worker's one queue, `jobs` (arch §5).

Each function runs one statement on the cursor it is given, so the caller decides whether it
commits alone or inside a transaction (app/db.py). Queue names reach SQL as parameters, except
in `unhide`, which names pgmq's table for the queue and checks the name first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from psycopg import Cursor, sql

QUEUE = "jobs"

_QUEUE_NAME = re.compile(r"^[a-z0-9_]{1,47}$")


@dataclass(frozen=True)
class Message:
    msg_id: int
    # pgmq's count of reads, this one included. A try is a read, so a crash counts (D-123).
    read_ct: int
    # The jsonb as psycopg decodes it, not yet checked against any job's message model.
    body: Any


def read(cur: Cursor[Any], queue: str, visibility_timeout_s: int) -> Message | None:
    """Reads the oldest visible message and hides it for `visibility_timeout_s`."""
    cur.execute(
        "select msg_id, read_ct, message from pgmq.read(%s::text, %s::integer, 1::integer)",
        (queue, visibility_timeout_s),
    )
    row = cur.fetchone()
    return None if row is None else Message(msg_id=row[0], read_ct=row[1], body=row[2])


def delete(cur: Cursor[Any], queue: str, msg_id: int) -> bool:
    cur.execute("select pgmq.delete(%s::text, %s::bigint)", (queue, msg_id))
    row = cur.fetchone()
    return bool(row and row[0])


def archive(cur: Cursor[Any], queue: str, msg_id: int) -> bool:
    cur.execute("select pgmq.archive(%s::text, %s::bigint)", (queue, msg_id))
    row = cur.fetchone()
    return bool(row and row[0])


def make_visible(cur: Cursor[Any], queue: str, msg_id: int) -> None:
    """Makes a message readable now. It is then the oldest visible message again."""
    cur.execute("select msg_id from pgmq.set_vt(%s::text, %s::bigint, 0::integer)", (queue, msg_id))


def unhide(cur: Cursor[Any], queue: str) -> list[int]:
    """Makes every message a stopped worker left hidden readable again, and returns their ids.

    A message with read_ct 0 has never been read, so a future vt there is a delay its sender
    asked for, and it stays.
    """
    if not _QUEUE_NAME.match(queue):
        raise ValueError(f"not a pgmq queue name: {queue!r}")
    cur.execute(
        sql.SQL(
            "update {} set vt = clock_timestamp()"
            " where vt > clock_timestamp() and read_ct > 0"
            " returning msg_id"
        ).format(sql.Identifier("pgmq", f"q_{queue}"))
    )
    return sorted(row[0] for row in cur.fetchall())
