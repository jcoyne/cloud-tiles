//! WebAssembly bindings around the `j2k-native` JPEG 2000 / HTJ2K decoder.
//!
//! The browser side synthesizes a small, valid codestream (or JP2 file) for
//! the area it wants and hands it to [`decode`]. Output is always RGBA8 so it
//! can go straight into `ImageData`.

use j2k_native::{
    CpuDecodeParallelism, DecodeSettings, DecoderContext, Image,
};
use wasm_bindgen::prelude::*;

/// Decoded pixels, always interleaved RGBA8.
#[wasm_bindgen]
pub struct DecodedImage {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl DecodedImage {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Move the pixel buffer out to JS (a `Uint8Array` copy of wasm memory).
    #[wasm_bindgen(js_name = takeData)]
    pub fn take_data(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.data)
    }
}

/// Basic facts about an image, for sanity checks against the TS parser.
#[wasm_bindgen]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    #[wasm_bindgen(js_name = tileCount)]
    pub tile_count: u32,
    #[wasm_bindgen(js_name = bitDepth)]
    pub bit_depth: u8,
    #[wasm_bindgen(js_name = hasAlpha)]
    pub has_alpha: bool,
}

fn settings() -> DecodeSettings {
    DecodeSettings::lenient()
}

fn to_js(err: impl std::fmt::Display) -> JsError {
    JsError::new(&err.to_string())
}

/// Parse a JP2/JPH file or raw codestream without decoding pixels.
#[wasm_bindgen]
pub fn inspect(bytes: &[u8]) -> Result<ImageInfo, JsError> {
    let image = Image::new(bytes, &settings()).map_err(to_js)?;
    Ok(ImageInfo {
        width: image.width(),
        height: image.height(),
        tile_count: image.tile_count(),
        bit_depth: image.original_bit_depth(),
        has_alpha: image.has_alpha(),
    })
}

/// Decode `bytes` after discarding `reduction` resolution levels.
///
/// The region `(x, y, w, h)` is in reduced-resolution pixels; pass `w == 0`
/// or `h == 0` to decode the whole reduced image.
#[wasm_bindgen]
pub fn decode(
    bytes: &[u8],
    reduction: u8,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<DecodedImage, JsError> {
    let image = Image::new_with_reduction(bytes, &settings(), reduction).map_err(to_js)?;
    let mut ctx = DecoderContext::default();
    ctx.set_cpu_decode_parallelism(CpuDecodeParallelism::Serial);

    let bitmap = if w == 0 || h == 0 {
        image.decode_with_context(&mut ctx)
    } else {
        image.decode_region_with_context((x, y, w, h), &mut ctx)
    }
    .map_err(to_js)?;

    let pixels = bitmap.width as usize * bitmap.height as usize;
    let data = to_rgba(&bitmap.data, pixels)?;
    Ok(DecodedImage {
        width: bitmap.width,
        height: bitmap.height,
        data,
    })
}

/// Expand interleaved 8-bit gray, gray+alpha, RGB or RGBA samples to RGBA.
fn to_rgba(src: &[u8], pixels: usize) -> Result<Vec<u8>, JsError> {
    if pixels == 0 {
        return Ok(Vec::new());
    }
    let channels = src.len() / pixels;
    let mut out = vec![0_u8; pixels * 4];
    match channels {
        1 => {
            for (o, &g) in out.chunks_exact_mut(4).zip(src) {
                o.copy_from_slice(&[g, g, g, 255]);
            }
        }
        2 => {
            for (o, s) in out.chunks_exact_mut(4).zip(src.chunks_exact(2)) {
                o.copy_from_slice(&[s[0], s[0], s[0], s[1]]);
            }
        }
        3 => {
            for (o, s) in out.chunks_exact_mut(4).zip(src.chunks_exact(3)) {
                o.copy_from_slice(&[s[0], s[1], s[2], 255]);
            }
        }
        4 => out.copy_from_slice(&src[..pixels * 4]),
        n => return Err(JsError::new(&format!("unsupported channel count {n}"))),
    }
    Ok(out)
}
