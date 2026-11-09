import { Router } from "express";
import { createTransferencia } from "../controllers/movimientos.controller.js";

const router = Router();

router.post("/", createTransferencia);

export default router;
