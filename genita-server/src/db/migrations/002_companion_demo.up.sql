-- D41: the ready-made demo companion a Judge access account starts with (src/prep/demo.ts).
ALTER TABLE companions ADD COLUMN demo boolean NOT NULL DEFAULT false;
