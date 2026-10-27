# Receipt retention

Every production Hub runtime starts `ReceiptRetention` after application startup and stops it
before closing the database. PostgreSQL and embedded instances use the same policy; there are no
settings to enable or tune it.

A receipt expires when its `received_at` is strictly older than seven days, it has a committed drop
reason and no accepted routes, and neither a trigger run nor an attachment capability references
it. Routed receipts stay even after their runs disappear. Receipts whose intake has not committed
a drop decision stay too. Expired receipts lose their payload, history, and delivery/signature
deduplication; a subsequent delivery is evaluated against the current configuration.

The first sweep starts asynchronously at startup. Each query examines at most 500 receipt IDs,
using the existing primary key to advance even through pages containing only retained receipts.
A sweep uses one fixed cutoff. Batches run sequentially with a 250 ms pause; completed sweeps
repeat after an hour. Failures keep the cursor in place and retry after a minute. Restarts safely
begin another sweep. There is no large transaction, full-table delete, or startup-blocking cleanup.

Cleanup logs report scanned and deleted counts and sweep completion without event contents.
Deleting rows frees space for PostgreSQL to reuse after vacuum; it does not immediately reduce
allocated table bytes.
