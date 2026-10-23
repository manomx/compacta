# Legacy router compatibility

`router.mjs` is the compatibility gateway used by an older Compacta setup. It is
included for maintainers who need to inspect or migrate that route. A fresh
Compacta installation uses the service integration directly and does not require
this support router.

Do not copy another user's deployment/runtime files. They contain machine-local
ports, paths, and routing credentials. Migration must preserve active requests
and retain the original provider path. No personal verification records are
included in this directory.
