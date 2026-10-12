CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`product_id` text NOT NULL,
	`charge_id` text NOT NULL,
	`stars` integer NOT NULL,
	`credits` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_charge_id_uidx` ON `payments` (`charge_id`);--> statement-breakpoint
CREATE INDEX `payments_user_idx` ON `payments` (`user_id`);--> statement-breakpoint
CREATE TABLE `processed_updates` (
	`update_id` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`chat_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `processed_updates_created_idx` ON `processed_updates` (`created_at`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`stars` integer NOT NULL,
	`credits` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`amount` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`reason` text NOT NULL,
	`origin` text NOT NULL,
	`game_id` text,
	`chat_id` integer,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_idempotency_key_uidx` ON `transactions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `transactions_user_created_idx` ON `transactions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `transactions_chat_origin_idx` ON `transactions` (`chat_id`,`origin`);--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`username` text,
	`first_name` text,
	`language_code` text,
	`credits` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`bonus_at` integer,
	`rescue_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `users_credits_idx` ON `users` (`credits`);