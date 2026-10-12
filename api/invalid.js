export default function handler(req, res) {
    res.status(400).json({
        success: false,
        error: "Invalid Parameters",
        message: "You are not authorized to access this file or directory."
    });
}
