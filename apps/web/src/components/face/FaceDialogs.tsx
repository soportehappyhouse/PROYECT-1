"use client";

import { LicenceDialog } from "@/components/consent/LicenceDialog";
import { FaceSwapWizard } from "./FaceSwapWizard";

/** Global dialogs of the sprint 4 M1 module (mounted once next to Ajustes). */
export function FaceDialogs() {
  return (
    <>
      <LicenceDialog />
      <FaceSwapWizard />
    </>
  );
}
