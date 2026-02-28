import { ObjectId } from 'mongodb';

export class Project {
  constructor({
    _id = null,
    projectName,
    projectDescription,
    planner,
    designOffice,
    createdOn,
    changedOn,
    location,
    client,
    standard,
    country,
    language,
    comment,
    technicalSettings,
    templates,
    devices
  }) {
    this._id = _id || new ObjectId();
    this.projectName = projectName;
    this.projectDescription = projectDescription;
    this.planner = planner;
    this.designOffice = designOffice;
    this.createdOn = createdOn || new Date().toISOString();
    this.changedOn = changedOn || new Date().toISOString();
    this.location = location;
    this.client = client;
    this.standard = standard;
    this.country = country;
    this.language = language;
    this.comment = comment;
    this.technicalSettings = technicalSettings || {
      mediumVoltage: {
        nominalVoltage: '20',
        maxShortCircuitPower: '250',
        minShortCircuitPower: '100',
        maxCrossSection: '500',
        minCrossSection: '25'
      },
      lowVoltage: {
        nominalVoltage: '400',
        frequency: '50',
        permissibleTouchVoltage: '50',
        ambientTemperature: '45',
        numberOfPoles: '3-contact preferably, 4-contact if required',
        earthFaultDetection: 'if required',
        referencePoint: 'Transformer-secondary terminals',
        relativeOperatingVoltage: '100',
        maxPermissibleVoltage: '14',
        maxCrossSection: '300',
        minCrossSection: '1.5',
        enableReducedCrossSection: false
      }
    };
    this.templates = templates || { LV: [], MV: [], HV: [] };
    this.devices = devices || [];
  }

  static fromDocument(doc) {
    return new Project({
      _id: doc._id,
      projectName: doc.projectName,
      projectDescription: doc.projectDescription,
      planner: doc.planner,
      designOffice: doc.designOffice,
      createdOn: doc.createdOn,
      changedOn: doc.changedOn,
      location: doc.location,
      client: doc.client,
      standard: doc.standard,
      country: doc.country,
      language: doc.language,
      comment: doc.comment,
      technicalSettings: doc.technicalSettings,
      templates: doc.templates,
      devices: doc.devices
    });
  }

  toDocument() {
    return {
      _id: this._id,
      projectName: this.projectName,
      projectDescription: this.projectDescription,
      planner: this.planner,
      designOffice: this.designOffice,
      createdOn: this.createdOn,
      changedOn: this.changedOn,
      location: this.location,
      client: this.client,
      standard: this.standard,
      country: this.country,
      language: this.language,
      comment: this.comment,
      technicalSettings: this.technicalSettings,
      templates: this.templates,
      devices: this.devices
    };
  }
}