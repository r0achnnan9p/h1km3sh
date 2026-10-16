# Headless recorder CLI

Optional Python3 tool; install system curl, FFmpeg and ffprobe. Use only a recorder you are authorized to access. The recorder IP/account and all three local directory paths are required; no personal recorder or jump-host defaults are supplied.

~~~sh
# Create a private password file locally; never put the password in argv or Git.
python3 tools/hikvision-cli/hikvision_export.py 2026-01-01 12:00 12:01 201 sample --ip 192.0.2.10 --user operator --password-file /absolute/private/recorder-password --output-dir /absolute/private/clips --cache-dir /absolute/private/cache --work-dir /absolute/private/work
~~~

The example address is documentation-only; replace it and the account with your own authorized recorder. Alternatively use the HIKVISION_PASSWORD environment variable (or select its name with --password-env). The password file is read before that variable. No connection occurs merely by reading this example.

Direct connections are the default. To use a separately authorized SSH jump, add all four options: --jump jump.example.com --jump-user operator --jump-key /absolute/private/key --known-hosts /absolute/private/known_hosts. Supply trusted known-hosts data yourself; the tool requires strict host-key checking for this explicit CLI configuration. --no-jump disables an optional jump.

Dates/times use the recorder's wall clock, not a universal UTC interpretation. Media boundaries and device compatibility still need actual acceptance. Check parsing and pure helper behavior without a recorder: python3 -B tools/hikvision-cli/test_hikvision_export.py.
