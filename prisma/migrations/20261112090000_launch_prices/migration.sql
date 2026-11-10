-- Launch prices (BDT), with USD at about 123 BDT per USD.
-- Each row changes only while it still holds the original default price, so prices an admin has
-- already edited are left alone and this stays a no-op on every later start-up.

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 149, "amountUsd" = 1.21 WHERE "id" = 'price-starter-1' AND "amountBdt" = 990;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 399, "amountUsd" = 3.24, "compareAtBdt" = 447 WHERE "id" = 'price-starter-3' AND "amountBdt" = 2690;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 749, "amountUsd" = 6.09, "compareAtBdt" = 894 WHERE "id" = 'price-starter-6' AND "amountBdt" = 4990;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 1190, "amountUsd" = 9.67, "compareAtBdt" = 1788, "label" = '4 months free' WHERE "id" = 'price-starter-12' AND "amountBdt" = 8900;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 2490, "amountUsd" = 20.24, "saleCap" = 300 WHERE "id" = 'price-starter-0' AND "amountBdt" = 19900;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 249, "amountUsd" = 2.02 WHERE "id" = 'price-pro-1' AND "amountBdt" = 2490;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 669, "amountUsd" = 5.44, "compareAtBdt" = 747 WHERE "id" = 'price-pro-3' AND "amountBdt" = 6790;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 1249, "amountUsd" = 10.15, "compareAtBdt" = 1494 WHERE "id" = 'price-pro-6' AND "amountBdt" = 12700;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 1990, "amountUsd" = 16.18, "compareAtBdt" = 2988, "label" = '4 months free' WHERE "id" = 'price-pro-12' AND "amountBdt" = 22400;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 3990, "amountUsd" = 32.44, "saleCap" = 200 WHERE "id" = 'price-pro-0' AND "amountBdt" = 49900;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 349, "amountUsd" = 2.84 WHERE "id" = 'price-business-1' AND "amountBdt" = 5990;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 939, "amountUsd" = 7.63, "compareAtBdt" = 1047 WHERE "id" = 'price-business-3' AND "amountBdt" = 16190;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 1779, "amountUsd" = 14.46, "compareAtBdt" = 2094 WHERE "id" = 'price-business-6' AND "amountBdt" = 30500;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 2790, "amountUsd" = 22.68, "compareAtBdt" = 4188, "label" = '4 months free' WHERE "id" = 'price-business-12' AND "amountBdt" = 53900;

-- >>>
UPDATE "PlanPrice" SET "amountBdt" = 5500, "amountUsd" = 44.72, "saleCap" = 50, "isActive" = true WHERE "id" = 'price-business-0' AND "amountBdt" = 119000;
