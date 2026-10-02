# City backdrop cleanup

Mode: built-in `image_gen` image editing, two passes. Output:
`../public/assets/city-clean.webp` (2001 × 786). The original `city.webp` is retained.
Sharp was used only to encode the final generated PNG as WebP.

## First prompt

Use case: precise-object-edit. Edit target: the attached wide city image used as a landing page backdrop. Primary request: Remove every tiny AI-generated pseudo-letter, illegible sign, typography, marking or gibberish from ALL building facades and the bridge; reconstruct those exact small regions as seamless clean architectural glass/metal surfaces. In particular remove the dark horizontal fake lettering on the rounded tower around three quarters across the image. Keep the image otherwise unchanged: same very wide 2001:786 composition, camera, skyline, building positions, pale blue-white sunrise, bridges, water reflections, trees and empty area on the left. No added objects, no logo, no text, no signs. Preserve the established polished glass and pale mint/blue luxury architectural render style. This is surgical cleanup of in-image text, not a redesign. Output same wide landscape framing as the original.

## Second prompt

Surgical edit of this exact supplied image. There is still fake text on the large rounded glass tower near the right side, approximately 82% across and 38% down. REMOVE THE ENTIRE DARK HORIZONTAL SIGNAGE BAND there, replace it with clean uninterrupted pale blue reflective glass windows matching the tower. Also remove the small white fake lettering at the very top of that same tower near 23% down. Remove other tiny letters from all building facades. No words, no letters, no signs, no black signage strips anywhere. Keep every other pixel and object as close to the source as possible: same wide panoramic crop, water, skyline, light, trees, bridges, reflections. Do not redesign or add anything.
