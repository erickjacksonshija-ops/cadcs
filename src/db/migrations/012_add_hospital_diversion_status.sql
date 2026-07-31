-- Diversion status (see plan: "Hospital diversion/capacity status") -- real
-- CAD systems track which EDs are too full to safely accept new patients so
-- dispatch/crew don't route there. Advisory, not a hard block: a crew can
-- still transport a critical patient to a diverting hospital if it's
-- genuinely the only viable option (standard EMS practice), so this only
-- reorders/flags hospital-ranking results, it never removes a hospital from
-- the candidate list entirely.
ALTER TABLE hospitals
  ADD COLUMN diversion_status ENUM('accepting', 'diversion') NOT NULL DEFAULT 'accepting',
  ADD COLUMN diversion_reason VARCHAR(200) NULL,
  ADD COLUMN diversion_set_at TIMESTAMP NULL;
