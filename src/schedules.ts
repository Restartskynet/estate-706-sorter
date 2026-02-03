export type ScheduleId =
  | 'Admin_General'
  | 'A_Real_Estate'
  | 'B_Stocks_Bonds'
  | 'C_Cash_Notes'
  | 'D_Life_Insurance'
  | 'E_Joint_Property'
  | 'F_Other_Property'
  | 'I_Annuities_Retirement';

export interface WeightedTerm {
  term: string;
  weight: number;
}

export interface ScheduleDefinition {
  id: ScheduleId;
  label: string;
  keywords: WeightedTerm[];
  smallTerms: WeightedTerm[];
}

export interface FilenameRule {
  pattern: RegExp;
  schedule: ScheduleId;
}
