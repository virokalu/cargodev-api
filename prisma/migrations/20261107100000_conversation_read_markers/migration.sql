-- Chat read markers (additive): one nullable timestamp per side of a conversation.
-- A message of the other side created after the marker is "unread"; NULL = never read.
-- No default, no backfill: existing conversations show their other-side messages as unread until first opened.
-- Safe on a live database (nullable columns, no table rewrite).
ALTER TABLE "Conversation" ADD COLUMN "customerReadAt" TIMESTAMP(3),
ADD COLUMN "staffReadAt" TIMESTAMP(3);
