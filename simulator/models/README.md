# Optional scanner model

The simulator ships with a procedural MR scanner built from Three.js geometry, so it works offline with no assets.

If you have a licensed glTF model of a scanner, save it here as `scanner.glb`. When the page is served from `localhost`, it loads the file, scales it to the gantry size, and hides the procedural shell. Selection, highlighting and labels keep working because the model is attached to the same scene object.

Check the licence before using any downloaded model in a submission, and credit it in the README.
