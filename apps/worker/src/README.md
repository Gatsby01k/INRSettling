# apps/worker — jobs, sweepers, delivery

The only process that executes against providers, and therefore the only one
holding provider credentials or destination decryption (SECURITY.md § 8).

All financial state progression happens here: a request records intent and
enqueues; the worker moves the machine. Job classes arrive with the stages that
need them.
