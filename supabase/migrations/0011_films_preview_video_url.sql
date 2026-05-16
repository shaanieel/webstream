-- Optional Player4Me preview URL for enforcing free preview windows.
-- Fill this with a video that is physically clipped to 5 minutes for movies
-- and 7 minutes for series episode 1. If null, the app falls back to a
-- frontend timer, which cannot prevent iframe seeking with 100% accuracy.

alter table public.films
  add column if not exists preview_video_url text;