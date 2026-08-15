ALTER TABLE `simulator_state` ADD `venue` varchar(32) DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE `simulator_trades` ADD `venue` varchar(32) DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE `simulator_trades` ADD `venueOrderId` varchar(64);--> statement-breakpoint
ALTER TABLE `simulator_trades` ADD `feeUsd` double DEFAULT 0 NOT NULL;