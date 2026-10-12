import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { MOVIES, INITIAL_BOOKINGS, CONCESSIONS } from "./data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// In-memory data store
let movies = [...MOVIES];
let bookings = [...INITIAL_BOOKINGS];
let concessions = [...CONCESSIONS];

// Booked seat registry per key: `${movieId}_${theater}_${date}_${time}` => Set of seatIds
const bookedSeatsRegistry = new Map();

// Seed initial reservation
const initialShowKey = `m-1_CineSphere IMAX 4DX_2026-10-14_06:15 PM`;
bookedSeatsRegistry.set(initialShowKey, new Set(["E-5", "E-6", "C-3", "C-4"]));

// Helper to calculate show key
function getShowKey(movieId, theater, date, time) {
  return `${movieId}_${theater}_${date}_${time}`;
}

// 1. Get all movies with optional search, genre, rating filtering
app.get("/api/movies", (req, res) => {
  const { search, genre } = req.query;
  let results = [...movies];

  if (search) {
    const q = search.toLowerCase();
    results = results.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.director.toLowerCase().includes(q) ||
        m.genre.some((g) => g.toLowerCase().includes(q))
    );
  }

  if (genre && genre !== "All") {
    results = results.filter((m) =>
      m.genre.map((g) => g.toLowerCase()).includes(genre.toLowerCase())
    );
  }

  res.json({ success: true, count: results.length, data: results });
});

// 2. Get specific movie details
app.get("/api/movies/:id", (req, res) => {
  const movie = movies.find((m) => m.id === req.params.id);
  if (!movie) {
    return res.status(404).json({ success: false, message: "Movie not found" });
  }
  res.json({ success: true, data: movie });
});

// 3. Get concessions
app.get("/api/concessions", (req, res) => {
  res.json({ success: true, data: concessions });
});

// 4. Get seat layout & occupancy for a given show
app.get("/api/seats", (req, res) => {
  const { movieId, theater, date, time } = req.query;
  if (!movieId || !theater || !date || !time) {
    return res.status(400).json({
      success: false,
      message: "movieId, theater, date, and time are required query parameters"
    });
  }

  const movie = movies.find((m) => m.id === movieId);
  if (!movie) {
    return res.status(404).json({ success: false, message: "Movie not found" });
  }

  const showKey = getShowKey(movieId, theater, date, time);
  const occupiedSeatIds = bookedSeatsRegistry.get(showKey) || new Set();

  // Layout definition: 8 rows (A to H), 12 columns per row
  // Rows A-B: VIP ($22-$24)
  // Rows C-E: Premium ($16-$17.5)
  // Rows F-H: Standard ($12-$13)
  const rows = [
    { row: "A", tier: "vip", price: movie.prices.vip },
    { row: "B", tier: "vip", price: movie.prices.vip },
    { row: "C", tier: "premium", price: movie.prices.premium },
    { row: "D", tier: "premium", price: movie.prices.premium },
    { row: "E", tier: "premium", price: movie.prices.premium },
    { row: "F", tier: "standard", price: movie.prices.standard },
    { row: "G", tier: "standard", price: movie.prices.standard },
    { row: "H", tier: "standard", price: movie.prices.standard }
  ];

  const grid = rows.map((r) => {
    const seats = [];
    for (let c = 1; c <= 12; c++) {
      const seatId = `${r.row}-${c}`;
      // Add aisle gap spacing marker
      const isAisleRight = c === 3 || c === 9;
      seats.push({
        id: seatId,
        row: r.row,
        col: c,
        tier: r.tier,
        price: r.price,
        isAisleRight,
        isOccupied: occupiedSeatIds.has(seatId)
      });
    }
    return { row: r.row, tier: r.tier, price: r.price, seats };
  });

  res.json({
    success: true,
    data: {
      showKey,
      movieId,
      movieTitle: movie.title,
      theater,
      date,
      time,
      totalSeats: 96,
      occupiedCount: occupiedSeatIds.size,
      availableCount: 96 - occupiedSeatIds.size,
      pricing: movie.prices,
      grid
    }
  });
});

// 5. Create a new reservation
app.post("/api/bookings", (req, res) => {
  const {
    movieId,
    theater,
    date,
    time,
    seats,
    snacks,
    customer,
    paymentMethod
  } = req.body;

  if (!movieId || !theater || !date || !time) {
    return res.status(400).json({ success: false, message: "Show details are incomplete." });
  }

  if (!seats || !Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ success: false, message: "Please select at least 1 seat." });
  }

  if (!customer || !customer.fullName || !customer.email) {
    return res.status(400).json({ success: false, message: "Contact information is required." });
  }

  const movie = movies.find((m) => m.id === movieId);
  if (!movie) {
    return res.status(404).json({ success: false, message: "Movie not found." });
  }

  const showKey = getShowKey(movieId, theater, date, time);
  if (!bookedSeatsRegistry.has(showKey)) {
    bookedSeatsRegistry.set(showKey, new Set());
  }
  const occupiedSet = bookedSeatsRegistry.get(showKey);

  // Check seat collision
  const seatIds = seats.map((s) => s.id);
  const alreadyTaken = seatIds.filter((id) => occupiedSet.has(id));
  if (alreadyTaken.length > 0) {
    return res.status(409).json({
      success: false,
      message: `The following seat(s) were just taken: ${alreadyTaken.join(", ")}. Please pick other seats.`
    });
  }

  // Calculate pricing
  const seatsCost = seats.reduce((acc, s) => acc + (s.price || 0), 0);
  const snacksCost = (snacks || []).reduce(
    (acc, snack) => acc + (snack.price * (snack.quantity || 1)),
    0
  );
  const bookingFee = 2.5;
  const subtotal = seatsCost + snacksCost;
  const tax = Number((subtotal * 0.0825).toFixed(2));
  const total = Number((subtotal + bookingFee + tax).toFixed(2));

  // Mark seats as reserved
  seatIds.forEach((id) => occupiedSet.add(id));

  // Generate unique booking ID
  const randomSuffix = Math.floor(100000 + Math.random() * 900000);
  const bookingId = `BKG-${randomSuffix}`;

  const newBooking = {
    bookingId,
    movieId,
    movieTitle: movie.title,
    posterUrl: movie.posterUrl,
    theater,
    date,
    time,
    seats,
    snacks: snacks || [],
    customer,
    paymentMethod: paymentMethod || "Credit Card",
    subtotal: Number(subtotal.toFixed(2)),
    bookingFee,
    tax,
    total,
    status: "CONFIRMED",
    createdAt: new Date().toISOString()
  };

  bookings.unshift(newBooking);

  res.status(201).json({
    success: true,
    message: "Ticket booking confirmed successfully!",
    data: newBooking
  });
});

// 6. Look up booking by ID or email
app.get("/api/bookings/:id", (req, res) => {
  const booking = bookings.find(
    (b) => b.bookingId.toLowerCase() === req.params.id.toLowerCase()
  );
  if (!booking) {
    return res.status(404).json({ success: false, message: "Booking ticket not found." });
  }
  res.json({ success: true, data: booking });
});

// 7. Get all bookings for dashboard/lookup
app.get("/api/bookings", (req, res) => {
  const { email } = req.query;
  if (email) {
    const userBookings = bookings.filter(
      (b) => b.customer.email.toLowerCase() === email.toLowerCase()
    );
    return res.json({ success: true, count: userBookings.length, data: userBookings });
  }
  res.json({ success: true, count: bookings.length, data: bookings });
});

// 8. Cancel booking
app.delete("/api/bookings/:id", (req, res) => {
  const idx = bookings.findIndex(
    (b) => b.bookingId.toLowerCase() === req.params.id.toLowerCase()
  );
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "Booking ticket not found." });
  }

  const cancelled = bookings[idx];
  // Free up reserved seats
  const showKey = getShowKey(
    cancelled.movieId,
    cancelled.theater,
    cancelled.date,
    cancelled.time
  );
  if (bookedSeatsRegistry.has(showKey)) {
    const occupiedSet = bookedSeatsRegistry.get(showKey);
    cancelled.seats.forEach((s) => occupiedSet.delete(s.id));
  }

  bookings[idx].status = "CANCELLED";

  res.json({
    success: true,
    message: `Booking ${cancelled.bookingId} cancelled successfully.`,
    data: bookings[idx]
  });
});

// Fallback to SPA index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`🎬 Movie Booking Server is running on port ${PORT}`);
});
