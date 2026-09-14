export type RawLead = {
  lead_id: string;
  fecha_registro: string;
  canal: string;
  empresa_id: string;
  punto_venta_id: string;
  nombre_cliente: string;
  telefono: string;
  email: string;
  ciudad: string;
  modelo_interes_texto: string;
  estado_gestion: string;
  fecha_primer_contacto: string;
  campania: string;
};

export type RawAdvisor = {
  asesor_id: string;
  nombre: string;
  punto_venta_id: string;
  empresa_id: string;
  capacidad_diaria_leads: string;
  activo: string;
  fecha_ingreso: string;
};

export type RawMotorcycle = {
  sku: string;
  marca: string;
  linea: string;
  cilindraje: string;
  segmento: string;
  precio_lista: string;
  puntos_venta_disponibles: string;
  unidades_disponibles: string;
};
