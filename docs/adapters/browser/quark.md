# Quark Drive (夸克网盘)

**Mode**: Browser login · **Domain**: `pan.quark.cn`

Install the OpenCLI Browser Bridge and log in to Quark Drive in Chrome. File operations and upload resume reuse that browser profile; no separate developer token is required. The adapter uses the personal drive.

## Commands

| Command | Description |
| --- | --- |
| `login-status` | Verify the current browser login session |
| `whoami` | Show user ID, nickname, avatar, membership and storage quota |
| `login` | Open the login page and wait for manual login |
| `list --dir <path>` | List files with paths, metadata and pagination |
| `info <path-or-id>` | View a file or directory's metadata |
| `search <query>` | Search filenames recursively under `--dir` |
| `mkdir <name-or-path>` | Create a folder under an existing parent |
| `rename <path-or-id> --name <name>` | Rename without overwriting an existing destination |
| `move <path-or-id> --to <path>` | Move to an existing directory and verify the result |
| `delete <path-or-id>` | Delete to the recycle bin; directories require `--recursive` |
| `upload <file>` | Start a persistent background file upload |
| `uploads` | List OpenCLI Quark upload tasks and progress |
| `upload-status <id>` | View one upload task |
| `upload-pause <id>` | Pause and abort the in-flight part |
| `upload-resume <id>` | Resume with fresh browser credentials |
| `ls [path]` | Original recursive tree listing, retained for compatibility |
| `mv <fids>` / `rm <fids>` | Original batch move/delete by comma-separated IDs |
| `save <url>` | Save a shared link to your drive |
| `share-tree <url>` | Read a shared link's nested directory tree |

```bash
opencli quark login-status
opencli quark whoami -f json
opencli quark list --dir / --limit 100
opencli quark list --dir /Documents --sort time --desc
opencli quark info /Documents/report.pdf
opencli quark search report --dir /Documents --limit 50
opencli quark mkdir /Archive
opencli quark rename /Documents/report.pdf --name report-final.pdf
opencli quark move /Documents/report-final.pdf --to /Archive
opencli quark delete /Archive/report-final.pdf
opencli quark delete /Archive --recursive

opencli quark upload ./video.mp4 --dir /Documents
opencli quark upload ./report.pdf --dir /Documents --name report-2026.pdf --paused
opencli quark uploads -f json
opencli quark upload-status <id>
opencli quark upload-pause <id>
opencli quark upload-resume <id>
opencli quark uploads --status completed
```

`list`, `info`, `search` and `move` return the same fields as the Baidu Netdisk adapter: `name`, `path`, `type`, `size` (bytes), `modifiedAt` (Unix seconds), and `id`. Quark IDs are the same values called `fid` in the original commands. `rename` retains `status`, `fid` and `new_name` and adds the verified file metadata; `mkdir` retains `status`, `fid` and `name` and adds metadata. `info` returns metadata, not file contents.

New path arguments are absolute. `--to` and `--dir` identify directories; `--name` is a basename. `list` and `search` follow pagination to `--limit` (default 100, maximum 10,000). `--page` selects the starting page of a 100-entry API query. Search queries the drive index and checks each result's full path when filtering a directory. Missing totals, repeated pages and upstream failures raise errors instead of returning partial data. Folder metadata that omits a full path is resolved through its parent chain, with cycle detection.

`login-status` returns `loggedIn`, `status` (`logged_in` or `logged_out`) and `id`. It checks the account endpoint rather than treating a Cookie alone as proof of login. Network failures, HTTP 403 verification and malformed responses remain errors. `whoami` preserves `logged_in`, `site` and `nickname`, and adds `id`, `avatar`, the server's `membership` type (e.g. `SUPER_VIP`), `totalBytes`, `usedBytes` and `freeBytes`. Available capacity is zero if usage exceeds capacity. Credentials are excluded from output.

## Background uploads

Upload tasks use the same persistent task manager and control semantics as the Baidu Netdisk adapter. State is kept separately in `~/.opencli/quark/uploads/`, with mode 0700 for directories and 0600 for task files. Browser cookies stay in worker memory, delivered over a pipe rather than arguments or task JSON. Per-file upload handles and checksum checkpoints are private state needed for resumption; storage authorization headers are not persisted.

The command returns a task ID immediately. Closing the CLI or its browser tab does not stop the detached Node worker. Query `upload-status` to distinguish a queued upload from a completed remote file. Computer sleep, shutdown or expired server upload handles can interrupt transfers.

All upload commands return `id`, `name`, `remotePath`, `status`, `progress`, `uploadedBytes`, `size`, `speed` and `error`. Progress counts acknowledged **4 MiB parts**, excluding the part in flight, and stays at most 99.9% until final verification. `speed` is bytes/second for the last acknowledged part. Pausing aborts the current part; resume skips acknowledged parts, rechecks the account and local file, and retries unfinished parts. A pause can briefly return `pausing` until acknowledged. Task lists, status and pause work without a browser.

States include `queued`, `hashing`, `uploading`, `pausing`, `paused`, `finalizing`, `completed`, `failed`, `interrupted` and `uncertain`. Short preparation/finalization writes cannot be paused. The server can instantly finish a deduplicated upload during preparation. A lost response in a phase that may create or rename a file is `uncertain` and is never automatically replayed. Inspect the destination before starting another task.

Uploads first use a task-specific `.opencli-<task-id>.upload` name in the destination directory. After storage completion and metadata validation, the adapter renames that exact file to the requested name and independently verifies its identity, path and size. Existing destinations are rejected. An uncertain or interrupted finalization may leave the staging file; inspect it with `info` and remove it with `delete` if no longer needed. Mutation requests are not automatically retried.

Task controls apply to uploads created by OpenCLI on this computer, not unrelated browser or desktop-client transfers. One nonempty regular file is accepted per task, with at most 10,000 parts. Directories, empty files and a server-negotiated part size other than 4 MiB are rejected. Quark account, quota and file-size limits still apply.

## Original commands

```bash
opencli quark ls "Documents/Projects" --depth 3
opencli quark mkdir "Sub Folder" --parent "Documents"
opencli quark mkdir "Sub Folder" --parent-fid <fid>
opencli quark mv "fid1,fid2" --to "Documents"
opencli quark mv "fid1,fid2" --to-fid <fid>
opencli quark rm "fid1,fid2"
opencli quark share-tree https://pan.quark.cn/s/abc123
opencli quark save https://pan.quark.cn/s/abc123 --to "来自：分享"
opencli quark save https://pan.quark.cn/s/abc123 --to-fid <fid>
opencli quark save https://pan.quark.cn/s/abc123 --to "My Folder" --fids "fid1,fid2" --stoken <stoken>
```

`share-tree` returns the `stoken` needed for selected-file saves. `--to` and `--to-fid` cannot be combined. Prefer `delete` for independently verified single-target deletion; `rm` retains the original batch interface.

## Implementation evidence

Strategy: Cookie API, using the logged-in profile's scoped cookies. Contract: internal web endpoints, subject to Quark changes. Read requests were replayed against the account, membership, file list, search and detail endpoints. A page upload established precreate → server authorization → storage parts → completion → finish; a separate direct Cookie upload verified replay. Multipart authorization is requested from Quark for the task's own storage object; no signing secret is implemented or extracted. SHA-1 chaining state is a standard content checksum needed by subsequent parts. Storage requests use HTTPS under `*.pds.quark.cn` and never receive browser cookies.

A live 12 MiB + 17 byte upload was paused at 66.6% (two acknowledged parts), held at the same progress, resumed, and completed with four verified parts and matching final file identity/path/size. Storage ETag strings retain their exact response case for multipart completion while digest comparison is case-insensitive. Tests include this protocol requirement, delayed directory/rename visibility, no duplicate mutation retries, login polling without navigation, root-ID compatibility and the shared task manager's concurrency/crash protections.
