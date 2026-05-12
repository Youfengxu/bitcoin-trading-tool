CREATE TABLE `metric_snapshots` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ts` bigint NOT NULL,
	`price` double NOT NULL,
	`rsi14` double,
	`macdLine` double,
	`macdSignal` double,
	`macdHist` double,
	`bbUpper` double,
	`bbMiddle` double,
	`bbLower` double,
	`ema12` double,
	`ema26` double,
	`sma50` double,
	`sma200` double,
	`volumeSma20` double,
	`volumeRatio` double,
	`zScore` double,
	`rollingStdDev` double,
	`trendClassification` enum('trend','blip','neutral'),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `metric_snapshots_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `price_candles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openTime` bigint NOT NULL,
	`open` double NOT NULL,
	`high` double NOT NULL,
	`low` double NOT NULL,
	`close` double NOT NULL,
	`volume` double NOT NULL,
	`closeTime` bigint NOT NULL,
	`interval` varchar(10) NOT NULL DEFAULT '1m',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `price_candles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `simulator_state` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cashUsd` double NOT NULL DEFAULT 10000,
	`btcHolding` double NOT NULL DEFAULT 0,
	`totalValueUsd` double NOT NULL DEFAULT 10000,
	`seedAmountUsd` double NOT NULL DEFAULT 10000,
	`lastPrice` double DEFAULT 0,
	`isRunning` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `simulator_state_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `simulator_trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`signalId` int,
	`action` enum('buy','sell') NOT NULL,
	`price` double NOT NULL,
	`btcAmount` double NOT NULL,
	`usdValue` double NOT NULL,
	`cashAfter` double NOT NULL,
	`btcAfter` double NOT NULL,
	`totalValueAfter` double NOT NULL,
	`reasoning` text,
	`ts` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `simulator_trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `strategy_params` (
	`id` int AUTO_INCREMENT NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`params` json NOT NULL,
	`backtestReturnPct` double,
	`backtestSharpe` double,
	`backtestWinRate` double,
	`isActive` boolean NOT NULL DEFAULT false,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategy_params_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `trading_signals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ts` bigint NOT NULL,
	`signal` enum('buy','sell','hold') NOT NULL,
	`price` double NOT NULL,
	`confidence` double,
	`reasoning` text NOT NULL,
	`metricsSnapshot` json,
	`executed` boolean NOT NULL DEFAULT false,
	`outcome` enum('win','loss','pending') DEFAULT 'pending',
	`outcomePrice` double,
	`outcomeTs` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `trading_signals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `validation_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`periodStart` bigint NOT NULL,
	`periodEnd` bigint NOT NULL,
	`totalSignals` int NOT NULL,
	`correctSignals` int NOT NULL,
	`winRate` double NOT NULL,
	`sharpeRatio` double,
	`maxDrawdown` double,
	`avgReturn` double,
	`paramVersionUsed` int,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `validation_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `weekly_performance` (
	`id` int AUTO_INCREMENT NOT NULL,
	`weekStart` bigint NOT NULL,
	`weekEnd` bigint NOT NULL,
	`startValue` double NOT NULL,
	`endValue` double NOT NULL,
	`returnPct` double NOT NULL,
	`btcBuyHoldReturnPct` double NOT NULL,
	`totalTrades` int NOT NULL,
	`winRate` double,
	`sharpeRatio` double,
	`maxDrawdown` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `weekly_performance_id` PRIMARY KEY(`id`)
);
