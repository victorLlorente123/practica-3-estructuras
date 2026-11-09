import type { Request, Response } from "express";
import { ObjectId, type Collection } from "mongodb";
import type { ClienteT } from "../models/clientes.model.js";

let clientesCollection: Collection<ClienteT>;

export const configClienteCollection = (collection: Collection<ClienteT>) => {
    clientesCollection = collection;
}

export const createCliente = (req: Request, res: Response) => {
    if(!req.body || typeof req.body.nombre !== "string" || !req.body.nombre.trim()){
        res.status(400).json({ error: "El nombre es obligatorio" });
        return;
    }

    if(typeof req.body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email.trim())){
        res.status(400).json({ error: "El email no tiene un formato válido" });
        return;
    }

    if(typeof req.body.dni !== "string" || !/^\d{8}[A-Za-z]$/.test(req.body.dni.trim())){
        res.status(400).json({ error: "El DNI debe tener 8 dígitos y una letra" });
        return;
    }

    const nuevoCliente: ClienteT = {
        nombre: req.body.nombre.trim(),
        email: req.body.email.trim().toLowerCase(),
        dni: req.body.dni.trim().toUpperCase(),
        creadoEn: new Date()
    };

    clientesCollection.insertOne(nuevoCliente).then((result) => {
        res.status(201).json({ ...nuevoCliente, _id: result.insertedId });
    }).catch((error) => {
        if(error.code === 11000){
            res.status(409).json({ error: "Ya existe un cliente con ese email o DNI" });
            return;
        }

        res.status(500).json({ error: "Error al crear el cliente" });
    });
}

export const getClientes = (req: Request, res: Response) => {
    const paginaTexto = req.query.pagina ?? "1";
    const limiteTexto = req.query.limite ?? "20";

    if(typeof paginaTexto !== "string" || !/^\d+$/.test(paginaTexto) ||
       typeof limiteTexto !== "string" || !/^\d+$/.test(limiteTexto)){
        res.status(400).json({ error: "La página y el límite deben ser enteros positivos" });
        return;
    }

    const pagina = Number(paginaTexto);
    const limitePedido = Number(limiteTexto);
    const limite = Math.min(limitePedido, 100);
    const salto = (pagina - 1) * limite;

    if(!Number.isSafeInteger(pagina) || pagina < 1 || !Number.isSafeInteger(limitePedido) ||
       limitePedido < 1 || !Number.isSafeInteger(salto)){
        res.status(400).json({ error: "La página y el límite deben ser enteros positivos" });
        return;
    }

    clientesCollection.countDocuments().then((totalElementos) => {
        return clientesCollection.find().sort({ creadoEn: -1, _id: -1 }).skip(salto).limit(limite).toArray().then((datos) => {
            res.json({ datos, pagina, limite, totalElementos, totalPaginas: Math.ceil(totalElementos / limite) });
        });
    }).catch(() => {
        res.status(500).json({ error: "Error al listar los clientes" });
    });
}

export const getClienteWithID = (req: Request, res: Response) => {
    const id = String(req.params.id);

    if(!ObjectId.isValid(id)){
        res.status(400).json({ error: "El ID del cliente no es válido" });
        return;
    }

    clientesCollection.findOne({ _id: new ObjectId(id) }).then((cliente) => {
        if(!cliente){
            res.status(404).json({ error: "Cliente no encontrado" });
            return;
        }

        res.json(cliente);
    }).catch(() => {
        res.status(500).json({ error: "Error al buscar el cliente" });
    });
}

export const changeCliente = (req: Request, res: Response) => {
    const id = String(req.params.id);

    if(!ObjectId.isValid(id)){
        res.status(400).json({ error: "El ID del cliente no es válido" });
        return;
    }

    if(!req.body || Array.isArray(req.body) || typeof req.body !== "object" ||
       Object.keys(req.body).length === 0 || Object.keys(req.body).some((campo) => campo !== "nombre" && campo !== "email")){
        res.status(400).json({ error: "Solo se pueden modificar nombre y email; el DNI no se puede modificar" });
        return;
    }

    const cambios: { nombre?: string, email?: string } = {};

    if(req.body.nombre !== undefined){
        if(typeof req.body.nombre !== "string" || !req.body.nombre.trim()){
            res.status(400).json({ error: "El nombre no puede estar vacío" });
            return;
        }

        cambios.nombre = req.body.nombre.trim();
    }

    if(req.body.email !== undefined){
        if(typeof req.body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email.trim())){
            res.status(400).json({ error: "El email no tiene un formato válido" });
            return;
        }

        cambios.email = req.body.email.trim().toLowerCase();
    }

    clientesCollection.findOneAndUpdate({ _id: new ObjectId(id) }, { $set: cambios }, {
        returnDocument: "after"
    }).then((cliente) => {
        if(!cliente){
            res.status(404).json({ error: "Cliente no encontrado" });
            return;
        }

        res.json(cliente);
    }).catch((error) => {
        if(error.code === 11000){
            res.status(409).json({ error: "Ya existe un cliente con ese email" });
            return;
        }

        res.status(500).json({ error: "Error al modificar el cliente" });
    });
}
