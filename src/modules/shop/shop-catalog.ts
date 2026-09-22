export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'

export interface ShopEffect {
  health?: number
  fatigue?: number
  experience?: number
}

export interface ShopItemDefinition {
  key: string
  name: string
  description: string
  category: string
  price: number
  rarity: ItemRarity
  stock: number
  effects: ShopEffect
}

export const SHOP_CATEGORIES = ['خوراکی', 'درمانی', 'انرژی', 'آموزشی', 'ویژه'] as const

export const SHOP_ITEMS: readonly ShopItemDefinition[] = [
  {
    key: 'water',
    name: 'آب معدنی',
    description: 'کمک به بازیابی سریع و سبک',
    category: 'خوراکی',
    price: 5_000,
    rarity: 'common',
    stock: -1,
    effects: { health: 2, fatigue: -5 }
  },
  {
    key: 'snack',
    name: 'تنقلات سبک',
    description: 'رفع خستگی جزئی',
    category: 'خوراکی',
    price: 12_000,
    rarity: 'common',
    stock: -1,
    effects: { health: 3, fatigue: -8 }
  },
  {
    key: 'meal',
    name: 'وعده غذای کامل',
    description: 'بازیابی سلامت و خستگی',
    category: 'خوراکی',
    price: 45_000,
    rarity: 'common',
    stock: -1,
    effects: { health: 12, fatigue: -20 }
  },
  {
    key: 'energy_drink',
    name: 'نوشیدنی انرژی‌زا',
    description: 'کاهش سریع خستگی',
    category: 'انرژی',
    price: 90_000,
    rarity: 'uncommon',
    stock: -1,
    effects: { fatigue: -35 }
  },
  {
    key: 'coffee',
    name: 'قهوه اسپشیال',
    description: 'انرژی قابل توجه برای کارهای سنگین',
    category: 'انرژی',
    price: 300_000,
    rarity: 'rare',
    stock: -1,
    effects: { fatigue: -50 }
  },
  {
    key: 'firstaid',
    name: 'کیت کمک‌های اولیه',
    description: 'بازیابی چشمگیر سلامت',
    category: 'درمانی',
    price: 150_000,
    rarity: 'uncommon',
    stock: -1,
    effects: { health: 40 }
  },
  {
    key: 'vitamin',
    name: 'مکمل ویتامین',
    description: 'سلامت پایدار',
    category: 'درمانی',
    price: 220_000,
    rarity: 'uncommon',
    stock: -1,
    effects: { health: 15, fatigue: -10 }
  },
  {
    key: 'gympass',
    name: 'بلیت یک ماه باشگاه',
    description: 'سلامتی و کاهش خستگی روزانه',
    category: 'درمانی',
    price: 350_000,
    rarity: 'rare',
    stock: -1,
    effects: { health: 25 }
  },
  {
    key: 'knowledge_book',
    name: 'کتاب‌های آموزشی',
    description: 'افزایش تجربه و مهارت‌آموزی',
    category: 'آموزشی',
    price: 450_000,
    rarity: 'rare',
    stock: -1,
    effects: { experience: 80 }
  },
  {
    key: 'elixir',
    name: 'اکسیر بازیابی',
    description: 'بازگرداندن کامل سلامت و خستگی',
    category: 'ویژه',
    price: 1_200_000,
    rarity: 'epic',
    stock: 500,
    effects: { health: 100, fatigue: -100 }
  },
  {
    key: 'knowledge_crystal',
    name: 'کریستال دانش',
    description: 'افزایش چشمگیر تجربه',
    category: 'ویژه',
    price: 3_500_000,
    rarity: 'legendary',
    stock: 100,
    effects: { experience: 400 }
  }
]

export const rarityLabels: Record<ItemRarity, string> = {
  common: 'معمولی',
  uncommon: 'نادر',
  rare: 'کمیاب',
  epic: 'افسانه‌ای',
  legendary: 'اسطوره‌ای'
}