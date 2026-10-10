# MediaPipe Tasks (vision), vendored

Copied unchanged from `@mediapipe/tasks-vision@0.10.14` (npm). Licence: Apache-2.0 (Google LLC).

* `vision_bundle.mjs` and `wasm/vision_wasm_internal.{js,wasm}` (SIMD build; every current Chrome and Edge supports SIMD).

The hand model is NOT included. Download `hand_landmarker.task` once and save it as
`simulator/models/hand_landmarker.task`, then hand control works offline:

https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

If the local model is missing, the app tries the same file from storage.googleapis.com.
