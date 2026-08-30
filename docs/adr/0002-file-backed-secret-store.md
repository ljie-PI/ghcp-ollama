# Store secrets in protected files

GHC Gateway stores credentials in a dedicated, atomically replaced regular file under a protected `~/.ghc-gateway` directory, using Unix `0700`/`0600` permissions or Windows ACLs restricted to the current user and rejecting symlink or ownership mismatches. This avoids a mandatory native OS-vault dependency and works in headless environments with lower packaging and memory cost; secrets remain separate from SQLite, logs, metrics, and public errors, while a future credential-store adapter may add OS-vault support.
