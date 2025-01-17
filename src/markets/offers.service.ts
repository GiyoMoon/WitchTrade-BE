import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Item } from '../items/entities/item.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import { In, Repository } from 'typeorm';
import { OfferCreateDTO } from './dtos/offerCreate.dto';
import { Market } from './entities/market.entity';
import { Offer } from './entities/offer.entity';
import { Price } from './entities/price.entity';
import { Wish } from './entities/wish.entity';
import { OfferUpdateDTO } from './dtos/offerUpdate.dto';
import { OfferSyncDTO } from './dtos/offerSync.dto';
import { RARITY, SyncSettings } from '../users/entities/syncSettings.entity';
import { Notification } from 'src/notifications/entities/notification.entity';

@Injectable()
export class OffersService {
  constructor(
    @InjectRepository(User)
    private _userRepository: Repository<User>,
    @InjectRepository(Market)
    private _marketRepository: Repository<Market>,
    @InjectRepository(Offer)
    private _offerRepository: Repository<Offer>,
    @InjectRepository(Wish)
    private _wishRepository: Repository<Wish>,
    @InjectRepository(Item)
    private _itemRepository: Repository<Item>,
    @InjectRepository(Price)
    private _priceRepository: Repository<Price>,
    @InjectRepository(Notification)
    private _notificationReposity: Repository<Notification>,
    @InjectRepository(SyncSettings)
    private _syncSettingsRepository: Repository<SyncSettings>,
    private _notificationService: NotificationsService,
  ) {}

  public async createOffer(data: OfferCreateDTO, uuid: string) {
    const user = await this._userRepository.findOne(uuid, {
      relations: ['market'],
    });
    if (!user) {
      throw new HttpException('User not found.', HttpStatus.BAD_REQUEST);
    }

    if (!user.market) {
      throw new HttpException('User has no market.', HttpStatus.NOT_FOUND);
    }

    const existingOffer = await this._offerRepository.findOne({
      where: { item: { id: data.itemId }, market: user.market },
      relations: ['item', 'market'],
    });
    if (existingOffer) {
      throw new HttpException(
        'Item is already an offer',
        HttpStatus.BAD_REQUEST,
      );
    }

    const item = await this._itemRepository.findOne(data.itemId);
    if (!item || !item.tradeable) {
      throw new HttpException(
        'Item not found or is not tradeable',
        HttpStatus.NOT_FOUND,
      );
    }

    const mainPrice = await this._priceRepository.findOne(data.mainPriceId);
    if (!mainPrice) {
      throw new HttpException(
        `Main price with id "${data.mainPriceId}" not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    let secondaryPrice: Price;
    if (data.secondaryPriceId) {
      secondaryPrice = await this._priceRepository.findOne(
        data.secondaryPriceId,
      );
      if (!secondaryPrice) {
        throw new HttpException(
          `Secondary price with id "${data.secondaryPriceId}" not found.`,
          HttpStatus.NOT_FOUND,
        );
      }
    }

    const offer = new Offer();

    offer.market = user.market;
    offer.item = item;
    offer.mainPrice = mainPrice;
    if (mainPrice.withAmount) {
      if (!data.mainPriceAmount && data.mainPriceAmount !== 0) {
        throw new HttpException(
          `Main price "${mainPrice.priceKey}" needs price amount.`,
          HttpStatus.NOT_FOUND,
        );
      }
      offer.mainPriceAmount = data.mainPriceAmount;
    }
    if (!mainPrice.forOffers) {
      throw new HttpException(
        `Main price "${mainPrice.priceKey}" is not for offers.`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (secondaryPrice) {
      if (mainPrice.id === secondaryPrice.id) {
        throw new HttpException(
          `Main and secondary price can't be the same.`,
          HttpStatus.NOT_FOUND,
        );
      }
      offer.secondaryPrice = secondaryPrice;

      if (data.wantsBoth === undefined) {
        throw new HttpException(
          `wantsBoth property is required if second price is defined`,
          HttpStatus.BAD_REQUEST,
        );
      }
      offer.wantsBoth = data.wantsBoth;

      if (secondaryPrice.withAmount) {
        if (!data.secondaryPriceAmount && data.secondaryPriceAmount !== 0) {
          throw new HttpException(
            `Secondary price "${secondaryPrice.priceKey}" needs price amount.`,
            HttpStatus.NOT_FOUND,
          );
        }
        offer.secondaryPriceAmount = data.secondaryPriceAmount;
      }
      if (!secondaryPrice.forOffers) {
        throw new HttpException(
          `Secondary price "${mainPrice.priceKey}" is not for offers.`,
          HttpStatus.NOT_FOUND,
        );
      }
    }
    offer.quantity = data.quantity;

    const createdOffer = await this._offerRepository.save(offer);

    if (offer.quantity !== 0) {
      this._checkNotificationFor([offer], user);
    }

    await this._setLastUpdated(user.market);

    return createdOffer;
  }

  public async editOffer(id: number, data: OfferUpdateDTO, uuid: string) {
    const offer = await this._offerRepository.findOne(id, {
      relations: [
        'item',
        'mainPrice',
        'secondaryPrice',
        'market',
        'market.user',
      ],
    });
    if (!offer) {
      throw new HttpException('Offer not found.', HttpStatus.NOT_FOUND);
    }
    if (offer.market.user.id !== uuid) {
      throw new HttpException(
        'You do not own this offer.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (offer.mainPrice.id !== data.mainPriceId) {
      const mainPrice = await this._priceRepository.findOne(data.mainPriceId);
      if (!mainPrice) {
        throw new HttpException(
          `Main price with id "${data.mainPriceId}" not found.`,
          HttpStatus.NOT_FOUND,
        );
      }
      offer.mainPrice = mainPrice;
      if (!mainPrice.forOffers) {
        throw new HttpException(
          `Main price "${mainPrice.priceKey}" is not for offers.`,
          HttpStatus.NOT_FOUND,
        );
      }
    }
    if (offer.mainPrice.withAmount) {
      if (!data.mainPriceAmount && data.mainPriceAmount !== 0) {
        throw new HttpException(
          `Main price "${offer.mainPrice.priceKey}" needs price amount.`,
          HttpStatus.NOT_FOUND,
        );
      }
      offer.mainPriceAmount = data.mainPriceAmount;
    } else {
      offer.mainPriceAmount = null;
    }

    if (data.secondaryPriceId && offer.mainPrice.id !== data.secondaryPriceId) {
      const secondaryPrice = await this._priceRepository.findOne(
        data.secondaryPriceId,
      );
      if (!secondaryPrice) {
        throw new HttpException(
          `Secondary price with id "${data.secondaryPriceId}" not found.`,
          HttpStatus.NOT_FOUND,
        );
      }
      offer.secondaryPrice = secondaryPrice;
      if (!secondaryPrice.forOffers) {
        throw new HttpException(
          `Secondary price "${secondaryPrice.priceKey}" is not for offers.`,
          HttpStatus.NOT_FOUND,
        );
      }
    } else if (!data.secondaryPriceId) {
      offer.secondaryPrice = null;
    }
    if (offer.secondaryPrice && offer.secondaryPrice.withAmount) {
      if (!data.secondaryPriceAmount && data.secondaryPriceAmount !== 0) {
        throw new HttpException(
          `Secondary price "${offer.secondaryPrice.priceKey}" needs price amount.`,
          HttpStatus.NOT_FOUND,
        );
      }
      offer.secondaryPriceAmount = data.secondaryPriceAmount;
    } else {
      offer.secondaryPriceAmount = null;
    }

    if (offer.secondaryPrice) {
      if (data.wantsBoth === undefined) {
        throw new HttpException(
          `wantsBoth property is required if second price is defined`,
          HttpStatus.BAD_REQUEST,
        );
      }
      offer.wantsBoth = data.wantsBoth;
    } else {
      offer.wantsBoth = null;
    }

    offer.quantity = data.quantity;

    const updatedOffer = await this._offerRepository.save(offer);

    if (offer.quantity === 0) {
      this._checkDeleteNotificationFor([offer], offer.market.user);
    } else {
      this._checkNotificationFor([offer], offer.market.user);
    }

    await this._setLastUpdated(offer.market);

    return updatedOffer;
  }

  public async deleteOffer(id: number, uuid: string) {
    const offer = await this._offerRepository.findOne(id, {
      relations: ['item', 'market', 'market.user'],
    });
    if (!offer) {
      throw new HttpException('Offer not found.', HttpStatus.NOT_FOUND);
    }
    if (offer.market.user.id !== uuid) {
      throw new HttpException(
        'You do not own this offer.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    await this._offerRepository.remove(offer);

    this._checkDeleteNotificationFor([offer], offer.market.user);

    this._setLastUpdated(offer.market);

    return;
  }

  public async deleteAllOffers(uuid: string) {
    const user = await this._userRepository.findOne(uuid, {
      relations: ['market'],
    });
    if (!user) {
      throw new HttpException('User not found.', HttpStatus.BAD_REQUEST);
    }

    if (!user.market) {
      throw new HttpException('User has no market.', HttpStatus.NOT_FOUND);
    }

    const offers = await this._offerRepository.find({
      where: { market: { user: { id: uuid } } },
      relations: ['item', 'market', 'market.user'],
    });

    await this._offerRepository.remove(offers);

    this._checkDeleteNotificationFor(offers, user);

    this._setLastUpdated(user.market);

    return;
  }

  public async syncOffers(data: OfferSyncDTO, uuid: string) {
    const user = await this._userRepository.findOne(uuid, {
      relations: [
        'market',
        'inventory',
        'inventory.inventoryItems',
        'inventory.inventoryItems.item',
      ],
    });
    if (!user) {
      throw new HttpException('User not found.', HttpStatus.BAD_REQUEST);
    }

    if (!user.market) {
      throw new HttpException('User has no market.', HttpStatus.NOT_FOUND);
    }

    if (!user.inventory) {
      throw new HttpException(
        'User has no synced inventory.',
        HttpStatus.NOT_FOUND,
      );
    }

    const response = {
      newOffers: [],
      newOffersCount: 0,
      updatedOffers: [],
      updatedOffersCount: 0,
      deletedOffers: [],
      deletedOffersCount: 0,
    };
    const changedOffers: Offer[] = [];
    const deletedOffers: Offer[] = [];

    let existingOffers = await this._offerRepository.find({
      where: { market: user.market },
      relations: ['market', 'item', 'mainPrice', 'secondaryPrice'],
    });
    let rarities: string[] = [];
    if (data.rarity !== 31) {
      rarities = this._getRarityStrings(data.rarity);
      existingOffers = existingOffers.filter((eo) =>
        rarities.includes(eo.item.tagRarity),
      );
    }

    let wishes: Wish[];
    if (data.ignoreWishlistItems) {
      wishes = await this._wishRepository.find({
        where: { market: user.market },
        relations: ['market', 'item'],
      });
    }

    const prices = await this._priceRepository.find();

    if (
      !prices.some((p) => p.id === data.mainPriceItem.id) ||
      (data.secondaryPriceItem &&
        !prices.some((p) => p.id === data.secondaryPriceItem.id)) ||
      !prices.some((p) => p.id === data.mainPriceRecipe.id) ||
      (data.secondaryPriceRecipe &&
        !prices.some((p) => p.id === data.secondaryPriceRecipe.id))
    ) {
      throw new HttpException(
        'Some prices were not found in the database',
        HttpStatus.NOT_FOUND,
      );
    }

    if (
      !prices.find((p) => p.id === data.mainPriceItem.id).canBeMain ||
      !prices.find((p) => p.id === data.mainPriceRecipe.id).canBeMain
    ) {
      throw new HttpException(
        'Some prices which cannot be the main price are configured as the main price.',
        HttpStatus.NOT_FOUND,
      );
    }

    const ignoreListItems = (
      await this._itemRepository.findByIds(data.ignoreList.map((i) => i.id))
    ).filter((i) => i.tradeable);

    if (data.mode === 'both' || data.mode === 'new') {
      const itemsToInsert = user.inventory.inventoryItems.filter((ii) => {
        const toKeep =
          ii.item.tagSlot === 'recipe' ? data.keepRecipe : data.keepItem;
        return (
          (data.rarity === 31 || rarities.includes(ii.item.tagRarity)) &&
          ii.amount > toKeep &&
          !existingOffers.find((o) => o.item.id === ii.item.id) &&
          (!data.ignoreWishlistItems ||
            !wishes.some((w) => w.item.id === ii.item.id)) &&
          !ignoreListItems.some((ili) => ili.id === ii.item.id) &&
          ii.item.tradeable &&
          ii.item.tagSlot !== 'ingredient'
        );
      });

      const offers: Offer[] = [];
      for (const itemToInsert of itemsToInsert) {
        const offer = new Offer();

        offer.market = user.market;

        let inStock: number;
        if (itemToInsert.item.tagSlot === 'recipe') {
          inStock =
            itemToInsert.amount - data.keepRecipe >= 0
              ? itemToInsert.amount - data.keepRecipe
              : 0;
        } else {
          inStock =
            itemToInsert.amount - data.keepItem >= 0
              ? itemToInsert.amount - data.keepItem
              : 0;
        }
        offer.quantity = inStock;

        const mainPrice =
          itemToInsert.item.tagSlot === 'recipe'
            ? prices.find((p) => p.id === data.mainPriceRecipe.id)
            : prices.find((p) => p.id === data.mainPriceItem.id);
        if (mainPrice.priceKey.startsWith('dynamic')) {
          offer.mainPrice = this._resolveDynamicPrice(
            itemToInsert.item,
            mainPrice,
            prices,
          );
        } else {
          offer.mainPrice = mainPrice;
        }
        if (offer.mainPrice.withAmount) {
          offer.mainPriceAmount =
            itemToInsert.item.tagSlot === 'recipe'
              ? data.mainPriceAmountRecipe
              : data.mainPriceAmountItem;
        }

        const secondaryPrice =
          itemToInsert.item.tagSlot === 'recipe'
            ? prices.find((p) => p.id === data.secondaryPriceRecipe?.id)
            : prices.find((p) => p.id === data.secondaryPriceItem?.id);
        const wantsBoth =
          itemToInsert.item.tagSlot === 'recipe'
            ? data.wantsBothRecipe
            : data.wantsBothItem;
        if (secondaryPrice) {
          if (secondaryPrice.priceKey.startsWith('dynamic')) {
            offer.secondaryPrice = this._resolveDynamicPrice(
              itemToInsert.item,
              secondaryPrice,
              prices,
            );
          } else {
            offer.secondaryPrice = secondaryPrice;
          }
          if (offer.secondaryPrice && offer.secondaryPrice.withAmount) {
            offer.secondaryPriceAmount =
              itemToInsert.item.tagSlot === 'recipe'
                ? data.secondaryPriceAmountRecipe
                : data.secondaryPriceAmountItem;
          }
          offer.wantsBoth = wantsBoth;
        }

        offer.item = itemToInsert.item;
        offers.push(offer);
      }
      const insertedNewOffers = await this._offerRepository.save(offers);
      response.newOffersCount = offers.length;
      response.newOffers = insertedNewOffers.map((ino) => ino.id);
      changedOffers.push(...offers);
    }
    if (data.mode === 'both' || data.mode === 'existing') {
      const updatedOffers = [];
      const offersToUpdate: Offer[] = [];
      const offersToDelete: Offer[] = [];
      for (const offer of existingOffers) {
        // don't change items that are in the user's wishlist or in the ignoreList
        if (
          (data.ignoreWishlistItems &&
            wishes.some((w) => w.item.id === offer.item.id)) ||
          ignoreListItems.some((ili) => ili.id === offer.item.id)
        ) {
          continue;
        }
        if (
          user.inventory.inventoryItems.find(
            (ii) => ii.item.id === offer.item.id,
          )
        ) {
          const toKeep =
            user.inventory.inventoryItems.find(
              (ii) => ii.item.id === offer.item.id,
            ).item.tagSlot === 'recipe'
              ? data.keepRecipe
              : data.keepItem;
          const inStock =
            user.inventory.inventoryItems.find(
              (ii) => ii.item.id === offer.item.id,
            ).amount -
              toKeep >=
            0
              ? user.inventory.inventoryItems.find(
                  (ii) => ii.item.id === offer.item.id,
                ).amount - toKeep
              : 0;
          if (
            offer.quantity !== inStock &&
            (!data.removeNoneOnStock || inStock !== 0)
          ) {
            updatedOffers.push({
              id: offer.id,
              oldQuantity: offer.quantity,
              newQuantity: inStock,
            });
            offer.quantity = inStock;
            offersToUpdate.push(offer);
          }
          if (data.removeNoneOnStock && inStock === 0) {
            offersToDelete.push(offer);
          }
        } else {
          if (offer.quantity !== 0 && !data.removeNoneOnStock) {
            updatedOffers.push({
              id: offer.id,
              oldQuantity: offer.quantity,
              newQuantity: 0,
            });
            offer.quantity = 0;
            offersToUpdate.push(offer);
          }
          if (data.removeNoneOnStock) {
            offersToDelete.push(offer);
          }
        }
      }
      await this._offerRepository.save(offersToUpdate);
      await this._offerRepository.remove(offersToDelete);
      deletedOffers.push(...offersToDelete);
      changedOffers.push(...offersToUpdate);

      response.updatedOffersCount = offersToUpdate.length;
      response.updatedOffers = updatedOffers;
      response.deletedOffersCount = offersToDelete.length;
      response.deletedOffers = deletedOffers;
    }

    this._checkNotificationFor(
      changedOffers.filter((co) => co.quantity !== 0),
      user,
    );

    this._checkDeleteNotificationFor(
      [...deletedOffers, ...changedOffers.filter((co) => co.quantity === 0)],
      user,
    );

    this._setLastUpdated(user.market);

    this._updateSyncSettings(data, uuid);

    return response;
  }

  private _resolveDynamicPrice(
    item: Item,
    dynamicPrice: Price,
    prices: Price[],
  ): Price {
    switch (dynamicPrice.priceKey) {
      case 'dynamicRarity':
        return prices.find((p) => p.priceKey === item.tagRarity);
      case 'dynamicCharacter':
        switch (item.tagCharacter) {
          case 'hunter':
            return prices.find((p) => p.priceKey === 'rusty_nails');
          case 'witch':
            return prices.find((p) => p.priceKey === 'odd_mushroom');
          default:
            return null;
        }
      case 'dynamicEvent':
        switch (item.tagEvent) {
          case 'summerevent':
            return prices.find((p) => p.priceKey === 'shell');
          case 'halloween':
          case 'halloween2018':
          case 'halloween2019':
          case 'halloween2020':
          case 'halloween2022':
          case 'halloween2023':
          case 'halloween2024':
            return prices.find((p) => p.priceKey === 'ectoplasm');
          case 'theater':
            return prices.find((p) => p.priceKey === 'red_string');
          case 'plunderparty':
            return prices.find((p) => p.priceKey === 'coin');
          case 'winterdream':
          case 'winterdream witch':
          case 'winterdream2018':
          case 'winterdream2019':
          case 'winterdream2020':
          case 'winterdream2021':
          case 'winterdream2022':
          case 'winterdream2023':
          case 'winterdream2024':
            return prices.find((p) => p.priceKey === 'candy_cane');
          case 'witchforest':
            return prices.find((p) => p.priceKey === 'morgaryll_flower');
          case 'mystic sands':
            return prices.find((p) => p.priceKey === 'scarab');
          default:
            return null;
        }
      default:
        return null;
    }
  }

  private async _checkNotificationFor(offers: Offer[], user: User) {
    let users = await this._userRepository
      .createQueryBuilder('user')
      .select('user.id')
      .leftJoinAndSelect('user.market', 'market')
      .leftJoinAndSelect('market.wishes', 'wishes')
      .leftJoinAndSelect('wishes.item', 'item')
      .getMany();
    users = users.filter((u) => u.id !== user.id);
    for (const userToNotify of users) {
      for (const wish of userToNotify.market.wishes) {
        const offer = offers.find(
          (o) => o.item.id === wish.item.id && o.quantity > 0,
        );
        if (offer) {
          this._notificationService.sendNotification(
            userToNotify.id,
            user,
            wish.item,
          );
        }
      }
    }
  }

  private async _checkDeleteNotificationFor(offers: Offer[], user: User) {
    if (offers.length === 0) {
      return;
    }
    const notifications = await this._notificationReposity.find({
      where: {
        targetUser: { id: user.id },
        targetItem: { id: In(offers.map((o) => o.item.id)) },
      },
      relations: ['targetUser', 'targetItem'],
    });
    if (notifications.length === 0) {
      return;
    }
    this._notificationReposity.remove(notifications);
  }

  private async _setLastUpdated(market: Market) {
    if (market.user) {
      delete market.user;
    }
    market.lastUpdated = new Date();
    await this._marketRepository.update(market.id, market);
  }

  private _getRarityStrings(rarityNumber: number): string[] {
    const rarityLength = Object.keys(RARITY).length;
    const filler = new Array(rarityLength + 1).join('0');
    const negativeRarityLength = -Math.abs(rarityLength);

    const binaryRarityString = (filler + rarityNumber.toString(2)).slice(
      negativeRarityLength,
    );

    const rarities = [];

    for (const rarityEntry in RARITY) {
      if (
        binaryRarityString[Object.keys(RARITY).indexOf(rarityEntry)] === '1'
      ) {
        rarities.push(RARITY[rarityEntry]);
      }
    }

    return rarities;
  }

  public async _updateSyncSettings(data: OfferSyncDTO, uuid: string) {
    const user = await this._userRepository.findOne(uuid, {
      relations: ['syncSettings'],
    });
    if (!user) {
      console.error(
        `User not found when trying to save sync settings. uuid: ${uuid}`,
      );
      return;
    }

    const prices = await this._priceRepository.find();

    if (
      !prices.some((p) => p.id === data.mainPriceItem.id) ||
      (data.secondaryPriceItem &&
        !prices.some((p) => p.id === data.secondaryPriceItem.id)) ||
      !prices.some((p) => p.id === data.mainPriceRecipe.id) ||
      (data.secondaryPriceRecipe &&
        !prices.some((p) => p.id === data.secondaryPriceRecipe.id))
    ) {
      console.error(
        `Some prices were not found in the database when trying to save sync settings. price ids: ${data.mainPriceItem.id}, ${data.secondaryPriceItem.id}, ${data.mainPriceRecipe.id}, ${data.secondaryPriceRecipe.id}`,
      );
      return;
    }

    if (
      !prices.find((p) => p.id === data.mainPriceItem.id).canBeMain ||
      !prices.find((p) => p.id === data.mainPriceRecipe.id).canBeMain
    ) {
      console.error(
        `'Some prices which cannot be the main price are configured as the main price when trying to save sync settings. price ids: ${data.mainPriceItem.id}, ${data.mainPriceRecipe.id}`,
      );
      return;
    }

    const syncSettings = user.syncSettings;

    syncSettings.mode = data.mode;
    syncSettings.rarity = data.rarity;

    syncSettings.mainPriceItem = prices.find(
      (p) => p.id === data.mainPriceItem.id,
    );
    if (syncSettings.mainPriceItem.withAmount) {
      if (!data.mainPriceAmountItem) {
        console.error(
          `Main item price requires amount when trying to save sync settings. main price id: ${syncSettings.mainPriceItem.id}`,
        );
        return;
      }
      syncSettings.mainPriceAmountItem = data.mainPriceAmountItem;
    }

    if (data.secondaryPriceItem) {
      syncSettings.secondaryPriceItem = prices.find(
        (p) => p.id === data.secondaryPriceItem.id,
      );
      if (syncSettings.secondaryPriceItem.withAmount) {
        if (!data.secondaryPriceAmountItem) {
          console.error(
            `'Secondary item price requires amount when trying to save sync settings. main price id: ${syncSettings.secondaryPriceItem.id}`,
          );
          return;
        }
        syncSettings.secondaryPriceAmountItem = data.secondaryPriceAmountItem;
      }
      syncSettings.wantsBothItem = data.wantsBothItem;
    } else {
      syncSettings.secondaryPriceItem = null;
    }

    syncSettings.mainPriceRecipe = prices.find(
      (p) => p.id === data.mainPriceRecipe.id,
    );
    if (syncSettings.mainPriceRecipe.withAmount) {
      if (!data.mainPriceAmountRecipe) {
        console.error(
          `'Main recipe price requires amount when trying to save sync settings. main price id: ${syncSettings.mainPriceRecipe.id}`,
        );
        return;
      }
      syncSettings.mainPriceAmountRecipe = data.mainPriceAmountRecipe;
    }

    if (data.secondaryPriceRecipe) {
      syncSettings.secondaryPriceRecipe = prices.find(
        (p) => p.id === data.secondaryPriceRecipe.id,
      );
      if (syncSettings.secondaryPriceRecipe.withAmount) {
        if (!data.secondaryPriceAmountRecipe) {
          console.error(
            `'Secondary recipe price requires amount when trying to save sync settings. main price id: ${syncSettings.secondaryPriceRecipe.id}`,
          );
          return;
        }
        syncSettings.secondaryPriceAmountRecipe =
          data.secondaryPriceAmountRecipe;
      }
      syncSettings.wantsBothRecipe = data.wantsBothRecipe;
    } else {
      syncSettings.secondaryPriceRecipe = null;
    }

    syncSettings.keepItem = data.keepItem;
    syncSettings.keepRecipe = data.keepRecipe;
    syncSettings.ignoreWishlistItems = data.ignoreWishlistItems;
    syncSettings.removeNoneOnStock = data.removeNoneOnStock;

    syncSettings.ignoreList = (
      await this._itemRepository.findByIds(data.ignoreList.map((i) => i.id))
    ).filter((i) => i.tradeable);

    const updatedSyncSettings = await this._syncSettingsRepository.save(
      syncSettings,
    );

    return updatedSyncSettings;
  }
}
