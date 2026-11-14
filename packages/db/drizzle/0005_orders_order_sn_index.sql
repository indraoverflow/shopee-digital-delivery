-- IF NOT EXISTS because a database that already had the index created by hand during an
-- incident must not fail its way through a migration later.
CREATE INDEX IF NOT EXISTS "orders_order_sn_idx" ON "orders" USING btree ("order_sn");