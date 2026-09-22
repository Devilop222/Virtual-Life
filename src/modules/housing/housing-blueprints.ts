import { PropertyType } from '@prisma/client'

export interface PropertyBlueprint {
  type: PropertyType
  title: string
  level: number
  purchasePrice: number
  rentalPriceMonthly: number
  baseAssetValue: number
  fatigueRecoveryMultiplier: number
  healthRecoveryPerHour: number
}

export const PROPERTY_BLUEPRINTS: readonly PropertyBlueprint[] = [
  {
    type: PropertyType.ROOM,
    title: 'اتاق کارگری کوچک',
    level: 1,
    purchasePrice: 3_000_000,
    rentalPriceMonthly: 150_000,
    baseAssetValue: 2_500_000,
    fatigueRecoveryMultiplier: 1.2,
    healthRecoveryPerHour: 2
  },
  {
    type: PropertyType.SMALL_HOUSE,
    title: 'خانه نقلی مسکونی',
    level: 2,
    purchasePrice: 7_000_000,
    rentalPriceMonthly: 350_000,
    baseAssetValue: 6_000_000,
    fatigueRecoveryMultiplier: 1.5,
    healthRecoveryPerHour: 4
  },
  {
    type: PropertyType.APARTMENT,
    title: 'آپارتمان نوساز شهری',
    level: 3,
    purchasePrice: 15_000_000,
    rentalPriceMonthly: 700_000,
    baseAssetValue: 13_000_000,
    fatigueRecoveryMultiplier: 2.0,
    healthRecoveryPerHour: 6
  },
  {
    type: PropertyType.LARGE_HOUSE,
    title: 'خانه ویلایی دوبلکس',
    level: 4,
    purchasePrice: 30_000_000,
    rentalPriceMonthly: 1_400_000,
    baseAssetValue: 25_000_000,
    fatigueRecoveryMultiplier: 2.8,
    healthRecoveryPerHour: 8
  },
  {
    type: PropertyType.VILLA,
    title: 'باغ ویلای اختصاصی',
    level: 5,
    purchasePrice: 70_000_000,
    rentalPriceMonthly: 3_000_000,
    baseAssetValue: 60_000_000,
    fatigueRecoveryMultiplier: 4.0,
    healthRecoveryPerHour: 12
  },
  {
    type: PropertyType.MANSION,
    title: 'عمارت اشرافی مجلل',
    level: 6,
    purchasePrice: 180_000_000,
    rentalPriceMonthly: 7_500_000,
    baseAssetValue: 150_000_000,
    fatigueRecoveryMultiplier: 6.0,
    healthRecoveryPerHour: 20
  }
]