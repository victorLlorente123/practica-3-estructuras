import { Router } from "express";
import { createCliente, getClientes, getClienteWithID, changeCliente } from "../controllers/clientes.controller.js";

const router = Router();

router.post("/", createCliente);
router.get("/", getClientes);
router.get("/:id", getClienteWithID);
router.patch("/:id", changeCliente);

export default router;
