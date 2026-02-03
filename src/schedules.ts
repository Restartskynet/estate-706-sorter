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

export const SCHEDULES: ScheduleDefinition[] = [
  {
    id: 'Admin_General',
    label: 'Admin / General',
    keywords: [],
    smallTerms: [],
  },
  {
    id: 'A_Real_Estate',
    label: 'Schedule A - Real Estate',
    keywords: [],
    smallTerms: [],
  },
  {
    id: 'B_Stocks_Bonds',
    label: 'Schedule B - Stocks & Bonds',
    keywords: [],
    smallTerms: [],
  },
  {
    id: 'C_Cash_Notes',
    label: 'Schedule C - Cash & Notes',
    keywords: [],
    smallTerms: [],
  },
  {
    id: 'D_Life_Insurance',
    label: 'Schedule D - Life Insurance',
    keywords: [],
    smallTerms: [],
  },
  {
    id: 'E_Joint_Property',
    label: 'Schedule E - Joint Property',
    keywords: [],
    smallTerms: [],
  },
  {
    id: 'F_Other_Property',
    label: 'Schedule F - Other Property',
    keywords: [],
    smallTerms: [],
  },
  {
    id: 'I_Annuities_Retirement',
    label: 'Schedule I - Annuities / Retirement',
    keywords: [],
    smallTerms: [],
  },
];

export const FILENAME_RULES: FilenameRule[] = [];
