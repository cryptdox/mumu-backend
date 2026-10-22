-- Device push token (FCM) for call notifications when the app is closed
ALTER TABLE "Device" ADD COLUMN "pushToken" TEXT;
