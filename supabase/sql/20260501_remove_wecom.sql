-- 20260501_remove_wecom.sql
-- Removes WeCom from the supported delivery channels.

-- 1. Remove the WeCom invite URL from the seed/active data so it doesn't try to render or validate
DELETE FROM public.channel_invites WHERE channel = 'wecom';

-- 2. Restrict the check constraint back to the remaining 5 channels.
-- We must drop the existing check first.
ALTER TABLE public.channel_invites DROP CONSTRAINT IF EXISTS channel_invites_channel_check;

ALTER TABLE public.channel_invites
  ADD CONSTRAINT channel_invites_channel_check
  CHECK (channel IN ('feishu', 'slack', 'discord', 'telegram', 'notion'));

-- 3. (Optional) We leave digest_sent.channel free-form as before, so historical logs aren't broken.
