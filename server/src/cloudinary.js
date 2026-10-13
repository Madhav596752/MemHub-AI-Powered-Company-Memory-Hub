import { v2 as cloudinary } from 'cloudinary'

// Cloudinary is configured from server/.env:
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Nothing is hardcoded here.
export function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  )
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
  debug: true,
})

// Documents (PDF/DOCX/TXT) are not images, so they are stored as "raw" files.

// Upload a local file. Returns { url, publicId }.
// Files go into a per-company folder: memhub/<companyId>/<fileName>
export async function uploadDocumentFile(filePath, companyId, fileName) {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: 'raw',
      folder: `memhub/${companyId}`,
      public_id: fileName,
      use_filename: false,
      unique_filename: false,
      overwrite: false,
    })

    return {
      url: result.secure_url,
      publicId: result.public_id,
    }
  } catch (error) {
    console.error('Cloudinary upload diagnostic:', {
      message: error.message,
      http_code: error.http_code,
      name: error.name,
      responseHeaders: error.response?.headers,
      responseBody: error.response?.data,
      stack: error.stack,
    })

    // Preserve the original error for the existing route handler.
    throw error
  }
}

// Delete a file by its public ID. "not found" counts as success (already gone).
export async function deleteDocumentFile(publicId) {
  const result = await cloudinary.uploader.destroy(publicId, {
    resource_type: 'raw',
    invalidate: true,
  })
  if (result.result !== 'ok' && result.result !== 'not found') {
    throw new Error(`Cloudinary delete failed: ${result.result}`)
  }
}
