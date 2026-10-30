-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "open_id" TEXT NOT NULL,
    "union_id" TEXT,
    "user_id_feishu" TEXT,
    "name" TEXT NOT NULL,
    "en_name" TEXT,
    "email" TEXT,
    "mobile" TEXT,
    "avatar_url" TEXT,
    "avatar_thumb" TEXT,
    "tenant_key" TEXT,
    "raw_user_info" TEXT NOT NULL,
    "user_access_token" TEXT NOT NULL,
    "user_token_expires_at" DATETIME NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "refresh_token_expires_at" DATETIME NOT NULL,
    "scopes" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" DATETIME NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "needs_relogin" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "remember_me" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" DATETIME NOT NULL,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_open_id_key" ON "users"("open_id");

-- CreateIndex
CREATE INDEX "users_union_id_idx" ON "users"("union_id");

-- CreateIndex
CREATE INDEX "users_user_token_expires_at_idx" ON "users"("user_token_expires_at");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
