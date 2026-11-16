-- Migration 016: Add micronutrient tracking columns to nutrition_logs

alter table nutrition_logs
  add column if not exists vitamin_a_mcg integer,
  add column if not exists vitamin_c_mg integer,
  add column if not exists calcium_mg integer,
  add column if not exists iron_mg integer;
