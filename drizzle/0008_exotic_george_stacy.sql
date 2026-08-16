CREATE TABLE `positioning_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ccy` varchar(16) NOT NULL,
	`ts` bigint NOT NULL,
	`openInterestUsd` double,
	`volumeUsd` double,
	`longShortRatio` double,
	`takerBuyUsd` double,
	`takerSellUsd` double,
	`fundingRate` double,
	`price` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `positioning_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `positioning_ccy_ts` UNIQUE(`ccy`,`ts`)
);
