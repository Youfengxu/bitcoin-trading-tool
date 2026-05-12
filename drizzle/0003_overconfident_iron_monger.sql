ALTER TABLE `strategy_params` ADD `candleInterval` varchar(10) DEFAULT '1h' NOT NULL;--> statement-breakpoint
ALTER TABLE `strategy_params` ADD `heartbeatScheduleMinutes` int DEFAULT 60 NOT NULL;