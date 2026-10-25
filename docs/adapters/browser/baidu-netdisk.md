# Baidu Netdisk (百度网盘)

Reuse a Chrome profile logged in to **pan.baidu.com** with the OpenCLI Browser Bridge connected. No developer account or access token is required. These commands use the personal drive, not enterprise storage or shared-link contents.

| Command | Purpose |
| --- | --- |
| `login-status` | Check whether the current browser session is logged in |
| `whoami` | Show the logged-in user, membership and storage quota |
| `list` | List a directory's files and subdirectories |
| `info <path>` | View metadata for a file or directory |
| `search <query>` | Search filenames recursively under `--dir` |
| `rename <path> --name <name>` | Rename a file or directory |
| `move <path> --to <directory>` | Move a file or directory |
| `mkdir <path>` | Create a directory under an existing parent |
| `delete <path>` | Delete a file to Baidu's recycle bin; directories require `--recursive` |
| `upload <file>` | Start a persistent background upload |
| `uploads` | List OpenCLI upload tasks and progress |
| `upload-status <id>` | View one upload task |
| `upload-pause <id>` | Abort the active part and pause the task |
| `upload-resume <id>` | Resume unfinished parts using fresh browser login |

```bash
opencli baidu-netdisk login-status
opencli baidu-netdisk whoami -f json
opencli baidu-netdisk list --dir / --limit 100
opencli baidu-netdisk list --dir /Documents --sort time --desc
opencli baidu-netdisk info /Documents/report.pdf
opencli baidu-netdisk search report --dir /Documents --limit 50
opencli baidu-netdisk rename /Documents/report.pdf --name report-final.pdf
opencli baidu-netdisk mkdir /Archive
opencli baidu-netdisk move /Documents/report-final.pdf --to /Archive
opencli baidu-netdisk delete /Archive/report-final.pdf
opencli baidu-netdisk delete /Archive --recursive

opencli baidu-netdisk upload ./video.mp4 --dir /Archive
opencli baidu-netdisk upload ./report.pdf --dir /Archive --name report-2026.pdf --paused
opencli baidu-netdisk uploads -f json
opencli baidu-netdisk upload-status <id> -f json
opencli baidu-netdisk upload-pause <id>
opencli baidu-netdisk upload-resume <id>
opencli baidu-netdisk uploads --status completed
```

Remote paths must be absolute. `--to` and `--dir` are directories; `--name` is a basename. Uploads, renames and moves refuse to overwrite existing destinations. Renames and moves verify the resulting file ID using a separate metadata request. No mutation request is automatically retried after a lost response.

`delete` uses the normal web delete operation (recycle bin); it does not permanently erase files or empty the recycle bin. Directory deletion requires `--recursive`, and root deletion is refused. A separate metadata request verifies that the original path is absent before returning `status: deleted`.

`list`, `info`, `search`, `rename`, `move`, and `mkdir` share the fields `name`, `path`, `type`, `size` (bytes), `modifiedAt` (Unix seconds), and `id`. `list` and `search` follow pagination up to `--limit` (default 100, maximum 10,000); `--page` selects the starting API page. Pages request 100 entries, although Baidu can return a different count. Upstream failures and repeated pages raise errors instead of returning partial results. `info` returns metadata, not file contents; use `list --dir /` for the root.

`login-status` returns `loggedIn`, `status` (`logged_in` or `logged_out`), and `id` (null when logged out). It verifies the server's session response, so an expired Cookie does not count as logged in. A missing session Cookie or an explicit server authentication failure returns `logged_out`; network, HTTP, verification-page and malformed-response failures raise errors.

`whoami` requires a valid login and returns `loggedIn`, `id`, `username`, `avatar`, `membership` (`free`, `vip`, or `svip`), `totalBytes`, `usedBytes`, and `freeBytes`. Quota values are bytes; available space is zero when an account is over quota. An unavailable avatar is null. The user ID is checked against the session identity before reading quota. Both commands are read-only and omit Cookie and CSRF credentials from their output.

## Upload tasks

Uploads run in a detached Node worker on this computer. The CLI returns a task ID immediately; the initial `queued` response does not mean the remote file already exists. Query `upload-status` until `completed`, which is set only after a separate remote metadata check confirms the committed file. Closing the CLI or its browser tab does not stop the worker; sleeping or shutting down the computer can interrupt it.

Task state lives in `~/.opencli/baidu-netdisk/uploads/` (directory mode 0700, task files 0600). Browser Cookie and CSRF credentials travel to workers through a pipe and stay in memory; they are never stored in task files or command arguments. State includes the local path, account binding, file identity, part checksums, server upload handle, and acknowledged parts. Treat these files as private and do not edit them while tasks are running.

All upload commands return the same fields:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `remotePath` | Task ID, local filename, and full destination path |
| `status` | Current lifecycle state |
| `progress` | Percentage of file bytes acknowledged by Baidu, 0–100 |
| `uploadedBytes`, `size` | Acknowledged file bytes and total bytes |
| `speed` | Bytes/second for the last acknowledged part; zero while paused or finished |
| `error` | Failure information, or null |

Progress is checkpointed after each **4 MiB part**, not every network packet. A part currently in flight is excluded. Progress remains at most 99.9% until commit and remote verification finish. Parts Baidu already has are counted as acknowledged. Pausing aborts the in-flight part; that part is retried after resume. A pause request can briefly return `pausing` while the worker acknowledges it. Repeated metadata reads do not need a browser connection.

States are `queued` → `hashing` → `uploading` → `finalizing` → `completed`, plus `pausing`, `paused`, `failed`, `interrupted`, and `uncertain`. Local controls are locked to prevent competing resume/pause operations. Resume rechecks the original account, local file identity and part checksums, and skips acknowledged parts. Log in to the original account before resuming; expired browser credentials are refreshed on resume. An expired server upload handle can require a new task.

The brief `finalizing` phase cannot be paused. If the worker dies or loses the commit response in this phase, the task becomes `uncertain`; the adapter will not replay the commit. Inspect the destination with `info` and `list` before creating another task. A dead worker in an earlier phase becomes `interrupted` and can be resumed.

Task controls cover **uploads created by this adapter on this computer**. They do not control transfers in the Baidu desktop application or unrelated browser tabs. Upload accepts one nonempty regular file at a time, with at most 10,000 parts; directories and zero-byte files are rejected. Baidu account, quota, file-size, and rate limits still apply.

## Implementation evidence

Strategy: `COOKIE_API`; contract: internal web endpoints, subject to Baidu changes. Browser login supplies scoped cookies and `/api/gettemplatevariable` supplies the current CSRF token and account binding. Node requests use `/api/list`, `/api/search`, `/api/filemetas`, `/api/filemanager`, `/api/precreate`, `/api/create`, and the cookie-authenticated `d.pcs.baidu.com/rest/2.0/pcs/superfile2` part endpoint. Browser-generated upload signatures are not reproduced.

Read requests were checked with multiple inputs and pagination against the logged-in personal drive. A disposable upload through the page established the precreate → part → create contract; direct Cookie replay of another disposable file succeeded. Rename and move bind exact paths, use `async=0` and `ondup=fail`, check item errors, and verify destination identity. A 20 MiB file was paused after one 4 MiB part (19.9%), remained unchanged during pause, and resumed to completion with six acknowledged parts. A collision probe confirmed that `rtype=0` returns error -8 and preserves the existing file. Live write checks use only adapter-created probe files and directories. Synthetic tests cover pagination failures, authentication, checksum validation, interrupted parts, pause/resume, commit uncertainty, short reads, file changes, deletion verification, and task controls contending across separate processes.
