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
import { RARITY } from '../users/entities/syncSettings.entity';
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
    private _notificationService: NotificationsService
  ) { }

  public async createOffer(data: OfferCreateDTO, uuid: string) {
    const user = await this._userRepository.findOne(uuid, { relations: ['market'] });
    if (!user) {
      throw new HttpException(
        'User not found.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!user.market) {
      throw new HttpException(
        'User has no market.',
        HttpStatus.NOT_FOUND,
      );
    }

    const existingOffer = await this._offerRepository.findOne({ where: { item: { id: data.itemId }, market: user.market }, relations: ['item', 'market'] });
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
      secondaryPrice = await this._priceRepository.findOne(data.secondaryPriceId);
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
    const offer = await this._offerRepository.findOne(id, { relations: ['item', 'mainPrice', 'secondaryPrice', 'market', 'market.user'] });
    if (!offer) {
      throw new HttpException(
        'Offer not found.',
        HttpStatus.NOT_FOUND,
      );
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
      const secondaryPrice = await this._priceRepository.findOne(data.secondaryPriceId);
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
    const offer = await this._offerRepository.findOne(id, { relations: ['item', 'market', 'market.user'] });
    if (!offer) {
      throw new HttpException(
        'Offer not found.',
        HttpStatus.NOT_FOUND,
      );
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
    const user = await this._userRepository.findOne(uuid, { relations: ['market'] });
    if (!user) {
      throw new HttpException(
        'User not found.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!user.market) {
      throw new HttpException(
        'User has no market.',
        HttpStatus.NOT_FOUND,
      );
    }

    const offers = await this._offerRepository.find({ where: { market: { user: { id: uuid } } }, relations: ['item', 'market', 'market.user'] });

    await this._offerRepository.remove(offers);

    this._checkDeleteNotificationFor(offers, user);

    this._setLastUpdated(user.market);

    return;
  }

  public async syncOffers(data: OfferSyncDTO, uuid: string) {
    const user = await this._userRepository.findOne(uuid, { relations: ['market', 'inventory', 'inventory.inventoryItems', 'inventory.inventoryItems.item'] });
    if (!user) {
      throw new HttpException(
        'User not found.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!user.market) {
      throw new HttpException(
        'User has no market.',
        HttpStatus.NOT_FOUND,
      );
    }

    if (!user.inventory) {
      throw new HttpException(
        'User has no synced inventory.',
        HttpStatus.NOT_FOUND,
      );
    }

    const response = { newOffers: 0, updatedOffers: 0, deletedOffers: 0 };
    const changedOffers: Offer[] = [];
    const deletedOffers: Offer[] = [];

    let existingOffers = await this._offerRepository.find({ where: { market: user.market }, relations: ['market', 'item'] });
    let rarities: string[] = [];
    if (data.ms_rarity !== 31) {
      rarities = this._getRarityStrings(data.ms_rarity);
      existingOffers = existingOffers.filter(eo => rarities.includes(eo.item.tagRarity));
    }

    let wishes: Wish[];
    if (data.ms_ignoreWishlistItems) {
      wishes = await this._wishRepository.find({ where: { market: user.market }, relations: ['market', 'item'] });
    }

    let prices = await this._priceRepository.find();

    if (data.ms_mode === 'both' || data.ms_mode === 'new') {
      const itemsToInsert = user.inventory.inventoryItems.filter(
        ii => {
          const toKeep = ii.item.tagSlot === 'recipe' ? data.ms_keepRecipe : data.ms_keepItem;
          return (data.ms_rarity === 31 || rarities.includes(ii.item.tagRarity)) &&
            ii.amount > toKeep &&
            !existingOffers.find(o => o.item.id === ii.item.id) &&
            (!data.ms_ignoreWishlistItems || !wishes.find(w => w.item.id === ii.item.id)) &&
            ii.item.tradeable &&
            ii.item.tagSlot !== 'ingredient';
        });

      const offers: Offer[] = [];
      for (const itemToInsert of itemsToInsert) {
        const offer = new Offer();

        offer.market = user.market;

        let inStock: number;
        if (itemToInsert.item.tagSlot === 'recipe') {
          inStock = itemToInsert.amount - data.ms_keepRecipe >= 0 ? itemToInsert.amount - data.ms_keepRecipe : 0;
        } else {
          inStock = itemToInsert.amount - data.ms_keepItem >= 0 ? itemToInsert.amount - data.ms_keepItem : 0;
        }
        offer.quantity = inStock;
        offer.mainPrice = prices.find(p => p.priceKey === itemToInsert.item.tagRarity);
        offer.mainPriceAmount = itemToInsert.item.tagSlot === 'recipe' ? data.ms_defaultPriceRecipe : data.ms_defaultPriceItem;
        offer.item = itemToInsert.item;
        offers.push(offer);
      }
      await this._offerRepository.save(offers);
      response.newOffers = offers.length;
      changedOffers.push(...offers);
    }
    if (data.ms_mode === 'both' || data.ms_mode === 'existing') {
      const offersToUpdate: Offer[] = [];
      const offersToDelete: Offer[] = [];
      for (const offer of existingOffers) {
        // don't change items that are in the user's wishlist
        if (data.ms_ignoreWishlistItems && wishes.find(w => w.item.id === offer.item.id)) {
          continue;
        }
        if (user.inventory.inventoryItems.find(ii => ii.item.id === offer.item.id)) {
          const toKeep = user.inventory.inventoryItems.find(ii => ii.item.id === offer.item.id).item.tagSlot === 'recipe' ? data.ms_keepRecipe : data.ms_keepItem;
          const inStock = user.inventory.inventoryItems.find(ii => ii.item.id === offer.item.id).amount - toKeep >= 0 ? user.inventory.inventoryItems.find(ii => ii.item.id === offer.item.id).amount - toKeep : 0;
          if (offer.quantity !== inStock && (!data.ms_removeNoneOnStock || inStock !== 0)) {
            offer.quantity = inStock;
            offersToUpdate.push(offer);
          }
          if (data.ms_removeNoneOnStock && inStock === 0) {
            offersToDelete.push(offer);
          }
        } else {
          if (offer.quantity !== 0 && !data.ms_removeNoneOnStock) {
            offer.quantity = 0;
            offersToUpdate.push(offer);
          }
          if (data.ms_removeNoneOnStock) {
            offersToDelete.push(offer);
          }
        }
      }
      await this._offerRepository.save(offersToUpdate);
      await this._offerRepository.remove(offersToDelete);
      response.updatedOffers = offersToUpdate.length;
      response.deletedOffers = offersToDelete.length;
      changedOffers.push(...offersToUpdate);
      deletedOffers.push(...offersToDelete);
    }

    this._checkNotificationFor(changedOffers.filter(co => co.quantity !== 0), user);

    this._checkDeleteNotificationFor([...deletedOffers, ...changedOffers.filter(co => co.quantity === 0)], user);

    this._setLastUpdated(user.market);

    return response;
  }

  private async _checkNotificationFor(offers: Offer[], user: User) {
    let users = await this._userRepository.createQueryBuilder('user')
      .select('user.id')
      .leftJoinAndSelect('user.market', 'market')
      .leftJoinAndSelect('market.wishes', 'wishes')
      .leftJoinAndSelect('wishes.item', 'item')
      .getMany();
    users = users.filter(u => u.id !== user.id);
    for (const userToNotify of users) {
      for (const wish of userToNotify.market.wishes) {
        const offer = offers.find(o => o.item.id === wish.item.id && o.quantity > 0);
        if (offer) {
          this._notificationService.sendNotification(userToNotify.id, user, wish.item);
        }
      }
    }
  }

  private async _checkDeleteNotificationFor(offers: Offer[], user: User) {
    if (offers.length === 0) {
      return;
    }
    let notifications = await this._notificationReposity.find({ where: { targetUser: { id: user.id }, targetItem: { id: In(offers.map(o => o.item.id)) } }, relations: ['targetUser', 'targetItem'] });
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

    const binaryRarityString = (filler + rarityNumber.toString(2)).slice(negativeRarityLength);

    const rarities = [];

    for (const rarityEntry in RARITY) {
      if (binaryRarityString[Object.keys(RARITY).indexOf(rarityEntry)] === '1') {
        rarities.push(RARITY[rarityEntry]);
      }
    }

    return rarities;
  }
}
