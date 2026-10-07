"use client";

import { LicenceDialog } from "@/components/consent/LicenceDialog";
import { FaceSwapWizard } from "./FaceSwapWizard";

/** Global dialogs of the sprint 4 M1 module (mounted once next to Ajustes). */
export function FaceDialogs() {
  return (
    <>
      <FaceSwapWizard />
      {/* after the wizard: it opens on top of it (first swap without the licence) */}
      <LicenceDialog />
    </>
  );
}
