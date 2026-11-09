import type { Request, Response } from "express";
import { ObjectId, type Collection, type Filter } from "mongodb";
import type { ClienteT } from "../models/clientes.model.js";
import type { CuentaT } from "../models/cuentas.model.js";

let cuentasCollection: Collection<CuentaT>;
let clientesCollection: Collection<ClienteT>;
let ultimaAlta: Promise<void> = Promise.resolve();

export const configCuentaCollection = (collection: Collection<CuentaT>, clientes: Collection<ClienteT>) => {
    cuentasCollection = collection;
    clientesCollection = clientes;
}

const calcularModulo97 = (numero: string) => {
    let resto = 0;

    for(const digito of numero){
        resto = (resto * 10 + Number(digito)) % 97;
    }

    return resto;
}

export const generarIBAN = () => {
    let bban = "";

    for(let i = 0; i < 20; i++){
        bban += Math.floor(Math.random() * 10);
    }

    const control = String(98 - calcularModulo97(bban + "142800")).padStart(2, "0");
    return "ES" + control + bban;
}

export const validarIBAN = (iban: string) => {
    if(!/^ES\d{22}$/.test(iban)){
        return false;
    }

    return calcularModulo97(iban.slice(4) + "1428" + iban.slice(2, 4)) === 1;
}

const insertarCuenta = (cuenta: CuentaT): Promise<CuentaT> => {
    return cuentasCollection.insertOne(cuenta).then((result) => {
        return { ...cuenta, _id: result.insertedId };
    }).catch((error) => {
        if(error.code === 11000 && error.keyPattern?.iban){
            const siguienteCuenta = { ...cuenta, iban: generarIBAN() };
            delete siguienteCuenta._id;
            return insertarCuenta(siguienteCuenta);
        }

        throw error;
    });
}

export const createCuenta = (req: Request, res: Response) => {
    if(!req.body || typeof req.body.clienteId !== "string" || !ObjectId.isValid(req.body.clienteId)){
        res.status(400).json({ error: "El ID del cliente no es válido" });
        return;
    }

    if(req.body.tipo !== "corriente" && req.body.tipo !== "ahorro"){
        res.status(400).json({ error: "El tipo de cuenta debe ser corriente o ahorro" });
        return;
    }

    const nuevaCuenta: CuentaT = {
        clienteId: new ObjectId(req.body.clienteId),
        tipo: req.body.tipo,
        iban: generarIBAN(),
        saldo: 0,
        descubiertoMax: req.body.tipo === "corriente" ? 50000 : 0,
        estado: "activa",
        creadaEn: new Date()
    };

    const alta = ultimaAlta.then(() => {
        return clientesCollection.findOne({ _id: nuevaCuenta.clienteId }).then((cliente) => {
            if(!cliente){
                throw { status: 404, error: "Cliente no encontrado" };
            }

            return cuentasCollection.countDocuments({ clienteId: nuevaCuenta.clienteId, estado: { $ne: "cerrada" } });
        }).then((total) => {
            if(total >= 3){
                throw { status: 409, error: "El cliente ya tiene 3 cuentas no cerradas" };
            }

            return insertarCuenta(nuevaCuenta);
        });
    });

    ultimaAlta = alta.then(() => {}, () => {});

    alta.then((cuenta) => {
        res.status(201).json(cuenta);
    }).catch((error) => {
        res.status(error.status ?? 500).json({ error: error.error ?? "Error al crear la cuenta" });
    });
}

export const getCuentas = (req: Request, res: Response) => {
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

    const filtro: Filter<CuentaT> = {};

    if(req.query.clienteId !== undefined){
        if(typeof req.query.clienteId !== "string" || !ObjectId.isValid(req.query.clienteId)){
            res.status(400).json({ error: "El ID del cliente no es válido" });
            return;
        }

        filtro.clienteId = new ObjectId(req.query.clienteId);
    }

    if(req.query.tipo !== undefined){
        if(req.query.tipo !== "corriente" && req.query.tipo !== "ahorro"){
            res.status(400).json({ error: "El tipo de cuenta debe ser corriente o ahorro" });
            return;
        }

        filtro.tipo = req.query.tipo;
    }

    if(req.query.estado !== undefined){
        if(req.query.estado !== "activa" && req.query.estado !== "bloqueada" && req.query.estado !== "cerrada"){
            res.status(400).json({ error: "El estado de la cuenta no es válido" });
            return;
        }

        filtro.estado = req.query.estado;
    }

    cuentasCollection.countDocuments(filtro).then((totalElementos) => {
        return cuentasCollection.find(filtro).sort({ creadaEn: -1, _id: -1 }).skip(salto).limit(limite).toArray().then((datos) => {
            res.json({ datos, pagina, limite, totalElementos, totalPaginas: Math.ceil(totalElementos / limite) });
        });
    }).catch(() => {
        res.status(500).json({ error: "Error al listar las cuentas" });
    });
}

export const getCuentaWithID = (req: Request, res: Response) => {
    const id = String(req.params.id);

    if(!ObjectId.isValid(id)){
        res.status(400).json({ error: "El ID de la cuenta no es válido" });
        return;
    }

    cuentasCollection.findOne({ _id: new ObjectId(id) }).then((cuenta) => {
        if(!cuenta){
            res.status(404).json({ error: "Cuenta no encontrada" });
            return;
        }

        return clientesCollection.findOne({ _id: cuenta.clienteId }).then((cliente) => {
            if(!cliente){
                res.status(404).json({ error: "Titular de la cuenta no encontrado" });
                return;
            }

            res.json({ ...cuenta, titular: { nombre: cliente.nombre, email: cliente.email } });
        });
    }).catch(() => {
        res.status(500).json({ error: "Error al buscar la cuenta" });
    });
}

export const changeCuentaEstado = (req: Request, res: Response) => {
    const id = String(req.params.id);

    if(!ObjectId.isValid(id)){
        res.status(400).json({ error: "El ID de la cuenta no es válido" });
        return;
    }

    const estado = req.body?.estado;

    cuentasCollection.findOne({ _id: new ObjectId(id) }).then((cuenta) => {
        if(!cuenta){
            throw { status: 404, error: "Cuenta no encontrada" };
        }

        if(estado !== "activa" && estado !== "bloqueada" && estado !== "cerrada"){
            throw { status: 400, error: `Estado actual: ${cuenta.estado}; estado solicitado: ${String(estado)}. Estado inexistente` };
        }

        if(cuenta.estado === "cerrada" || cuenta.estado === estado){
            throw { status: 409, error: `Transición no permitida: estado actual ${cuenta.estado}, estado solicitado ${estado}` };
        }

        if(estado === "cerrada" && cuenta.saldo !== 0){
            throw { status: 409, error: `No se puede cerrar una cuenta con saldo distinto de 0 (saldo actual: ${cuenta.saldo}); estado actual ${cuenta.estado}, estado solicitado ${estado}` };
        }

        const filtro: Filter<CuentaT> = { _id: cuenta._id, estado: cuenta.estado };

        if(estado === "cerrada"){
            filtro.saldo = 0;
        }

        return cuentasCollection.findOneAndUpdate(filtro, { $set: { estado } }, {
            returnDocument: "after"
        }).then((cuentaActualizada) => {
            if(!cuentaActualizada){
                throw { status: 409, error: `La cuenta ha cambiado durante la petición. Consulta su estado antes de solicitar ${estado} de nuevo` };
            }

            return cuentaActualizada;
        });
    }).then((cuenta) => {
        res.json(cuenta);
    }).catch((error) => {
        res.status(error.status ?? 500).json({ error: error.error ?? "Error al cambiar el estado de la cuenta" });
    });
}
