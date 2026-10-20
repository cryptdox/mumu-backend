-- AlterTable
ALTER TABLE "LiveStream" ADD COLUMN     "hostDeviceId" TEXT;

-- CreateTable
CREATE TABLE "Device" (
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("userId","deviceId")
);

