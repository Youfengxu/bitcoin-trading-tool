-- Note: cusum/hurst/adx columns were applied via an out-of-band migration on the
-- existing deployment; the IF NOT EXISTS clauses make this migration idempotent
-- on systems that have or haven't received those columns yet. MariaDB 10.0.2+ /
-- MySQL 8.0.29+ supports this syntax.
ALTER TABLE `trading_signals` MODIFY COLUMN `outcome` enum('win','loss','pending','hold_correct','hold_missed') DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD COLUMN IF NOT EXISTS `cusumAlarm` boolean;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD COLUMN IF NOT EXISTS `cusumUp` double;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD COLUMN IF NOT EXISTS `cusumDown` double;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD COLUMN IF NOT EXISTS `hurstExponent` double;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD COLUMN IF NOT EXISTS `adx` double;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD COLUMN IF NOT EXISTS `adxPlus` double;--> statement-breakpoint
ALTER TABLE `metric_snapshots` ADD COLUMN IF NOT EXISTS `adxMinus` double;--> statement-breakpoint
ALTER TABLE `validation_log` ADD COLUMN IF NOT EXISTS `holdRegret` double;--> statement-breakpoint
ALTER TABLE `validation_log` ADD COLUMN IF NOT EXISTS `holdMissed` int;--> statement-breakpoint
ALTER TABLE `validation_log` ADD COLUMN IF NOT EXISTS `holdCorrect` int;--> statement-breakpoint
ALTER TABLE `validation_log` ADD COLUMN IF NOT EXISTS `riskAdjustedReturn` double;